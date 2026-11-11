#!/usr/bin/env node
// Starts the repository's local service, sends the given requests to it and prints one MEND_EVIDENCE line
// per response ({ method, url, status }), for a declared "request" capture. Only local URLs are accepted;
// the service is stopped afterwards, whatever happened.
//   emit-requests.mjs --start "<command>" --url http://localhost:<port> [--header "x-user: u1"] --request "POST /orders {json}" --request "POST /orders/{prev.id}/refunds {json}" ...
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocalHost } from './local-url.mjs';

export function parseRequest(text) {
  const match = /^([A-Z]+)\s+(\/\S*)(?:\s+(.+))?$/s.exec(String(text).trim());
  if (!match) throw new TypeError(`[EMIT-REQUESTS]: a request is "METHOD /path [json body]", got: ${text}`);
  const body = match[3] === undefined ? undefined : JSON.stringify(JSON.parse(match[3]));
  return { method: match[1], path: match[2], body };
}

// "{prev.id}" or "{prev.lines.0.sku}" takes a value from the previous JSON response, so a request can act
// on what the one before it created. A missing value is an error, never an empty string.
export function fillPrevious(text, previous) {
  return text.replace(/\{prev\.([A-Za-z0-9_.]+)\}/g, (token, keyPath) => {
    const value = keyPath.split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), previous);
    if (value === undefined || value === null || typeof value === 'object') throw new RangeError(`[EMIT-REQUESTS]: ${token} is not a value in the previous response`);
    return String(value);
  });
}

function parseArgs(argv) {
  const options = { requests: [], headers: {}, timeoutMs: 15000 };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new TypeError(`[EMIT-REQUESTS]: ${flag} needs a value`);
    if (flag === '--start') options.start = value;
    else if (flag === '--url') options.url = value;
    else if (flag === '--request') options.requests.push(parseRequest(value));
    else if (flag === '--header') {
      const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(value);
      if (!match) throw new TypeError(`[EMIT-REQUESTS]: a header is "Name: value", got: ${value}`);
      options.headers[match[1].toLowerCase()] = match[2];
    } else if (flag === '--timeout-ms') options.timeoutMs = Number(value);
    else throw new TypeError(`[EMIT-REQUESTS]: unknown option ${flag}`);
  }
  if (!options.start || !options.url || options.requests.length === 0) throw new TypeError('[EMIT-REQUESTS]: --start, --url and at least one --request are required');
  if (!isLocalHost(new URL(options.url).hostname)) throw new RangeError(`[EMIT-REQUESTS]: ${options.url} is not a local service`);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new RangeError('[EMIT-REQUESTS]: --timeout-ms must be positive');
  return options;
}

async function waitForService(url, timeoutMs, exited) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited()) throw new Error('[EMIT-REQUESTS]: the service exited before it answered');
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`[EMIT-REQUESTS]: ${url} did not answer within ${timeoutMs} ms`);
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 64;
  }
  let exited = false;
  const service = spawn(options.start, { shell: true, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
  service.on('exit', () => { exited = true; });
  try {
    await waitForService(options.url, options.timeoutMs, () => exited);
    let previous = null;
    for (const request of options.requests) {
      const url = new URL(fillPrevious(request.path, previous), options.url).toString();
      const body = request.body === undefined ? undefined : fillPrevious(request.body, previous);
      const response = await fetch(url, {
        method: request.method,
        headers: { ...options.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const text = await response.text();
      try { previous = JSON.parse(text); } catch { previous = null; }
      process.stdout.write(`MEND_EVIDENCE ${JSON.stringify({ method: request.method, url, status: response.status })}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  } finally {
    // The service runs in its own process group so its children stop with it.
    try { process.kill(-service.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
