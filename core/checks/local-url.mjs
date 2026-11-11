// Whether a URL points at a service or database on the owner's machine (or a reserved test name),
// so evidence recorded against shared or production hosts can be told apart.
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|[\w.-]+\.(?:localhost|local|test|invalid))$/i;
const FILE_PROTOCOLS = new Set(['file:', 'sqlite:', 'sqlite3:']);

export function isLocalHost(hostname) {
  return typeof hostname === 'string' && LOCAL_HOST.test(hostname);
}

/** True for local hosts and file-backed databases; false for remote hosts and text that is not a URL. */
export function isLocalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (FILE_PROTOCOLS.has(parsed.protocol)) return true;
  return isLocalHost(parsed.hostname);
}
