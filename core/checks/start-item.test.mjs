import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startItem, waitForStart, workflowArgs, StartError } from './start-item.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = {
  '/pkg/autopilot.json': { critic: 'claude-opus', model: 'claude-sonnet', auditor: 'claude-opus', engine: 'claude' },
  '/repo/.mend/items/low.json': { id: 'low', risk: 'low' },
  '/repo/.mend/items/risky.json': { id: 'risky', risk: 'high' },
};
const readJson = (file) => {
  if (!(file in files)) throw new Error(`no file ${file}`);
  return files[file];
};
function recorder(reply) {
  const calls = [];
  const run = (command, args, cwd) => { calls.push({ command, args, cwd }); return reply; };
  return { calls, run };
}
const pause = () => {};
const started = { ok: true, stdout: JSON.stringify({ schema: 'mendcode.cli', kind: 'result', data: { workflow: { workflowId: 'wfl_1', state: 'running' } } }), stderr: '' };

test('a low-risk item starts at once through the CLI, already approved, with the models from autopilot.json', () => {
  const { calls, run } = recorder(started);
  const result = startItem({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson, pause }, run);
  assert.deepEqual(result, { started: true, item: '.mend/items/low.json', workflowId: 'wfl_1' });
  const [{ command, args, cwd }] = calls;
  assert.ok(calls.slice(1).every((call) => call.args[1] === 'show'), 'after the start it only looks at the run');
  assert.equal(command, 'mendcode');
  assert.equal(cwd, '/repo');
  assert.deepEqual(args.slice(0, 3), ['workflow', 'run', '/pkg/workflows/mend.js']);
  assert.ok(calls.every((call) => !call.args.includes('--dir') && call.cwd === '/repo'), 'the repository is the working directory; --dir would start a second daemon with its data in the repository');
  assert.ok(args.includes('--yes'), 'the start needs no card');
  assert.deepEqual(JSON.parse(args[args.indexOf('--args') + 1]), { repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', critic: 'claude-opus', model: 'claude-sonnet', auditor: 'claude-opus', engine: 'claude' });
});

test('a package without an engine (engine null, the native one) passes no engine at all', () => {
  const args = workflowArgs({ repo: '/repo', item: '.mend/items/low.json', pkg: '/native', readJson: (file) => (file === '/native/autopilot.json' ? { critic: 'gpt-6-astra', model: 'gpt-6.1-terra', auditor: 'gpt-6-astra', engine: null } : readJson(file)) });
  assert.ok(!('engine' in args), JSON.stringify(args));
});

test('a high-risk item is not started until the user said yes to it', () => {
  const { calls, run } = recorder(started);
  const held = startItem({ repo: '/repo', item: '.mend/items/risky.json', pkg: '/pkg', readJson, pause }, run);
  assert.equal(held.started, false);
  assert.match(held.reason, /high risk/);
  assert.equal(calls.length, 0);
  assert.equal(startItem({ repo: '/repo', item: '.mend/items/risky.json', pkg: '/pkg', approved: true, readJson, pause }, run).workflowId, 'wfl_1');
});

test('a refused start or an answer without a workflow id is reported, never taken as started', () => {
  const refused = startItem({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson, pause }, recorder({ ok: false, stdout: '', stderr: 'error: project not trusted' }).run);
  assert.equal(refused.started, false);
  assert.match(refused.reason, /not trusted/);
  const empty = startItem({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson, pause }, recorder({ ok: true, stdout: 'plan: mend', stderr: '' }).run);
  assert.equal(empty.started, false);
});

test('a run that fails in its first seconds is reported as not started, with its reason', () => {
  const run = (command, args) => (args[1] === 'run' ? started : { ok: true, stdout: JSON.stringify({ data: { workflow: { workflowId: 'wfl_1', state: 'failed', reason: 'an agent on another engine needs the full tier' } } }), stderr: '' });
  const result = startItem({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson, pause }, run);
  assert.equal(result.started, false);
  assert.equal(result.workflowId, 'wfl_1');
  assert.match(result.reason, /full tier/);
});

test('a draft resumes with more owner rounds through --fix-rounds, bounded to three', () => {
  assert.equal(workflowArgs({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', fixRounds: '2', readJson }).fixRounds, 2);
  assert.ok(!('fixRounds' in workflowArgs({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson })));
  assert.throws(() => workflowArgs({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', fixRounds: 4, readJson }), StartError);
});

test('named models win, publish no is passed on, and bad paths are refused', () => {
  const args = workflowArgs({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', models: { model: 'claude-haiku' }, publish: 'no', readJson });
  assert.equal(args.model, 'claude-haiku');
  assert.equal(args.publish, 'no');
  assert.throws(() => workflowArgs({ repo: 'repo', item: '.mend/items/low.json', pkg: '/pkg', readJson }), StartError);
  assert.throws(() => workflowArgs({ repo: '/repo', item: '../x.json', pkg: '/pkg', readJson }), StartError);
});

test('the skill starts items with start-item; inside MendCode it makes the card call and keeps its turn alive until the run appears', () => {
  const skill = readFileSync(path.join(here, '../skills/mend-autopilot/SKILL.md'), 'utf8');
  assert.match(skill, /checks\/start-item\.mjs/);
  assert.ok(skill.indexOf('this file is not for you') < skill.indexOf('## 1.'), 'an owner that loads it is turned away before any lead instruction');
  assert.doesNotMatch(skill, /approve every start/i);
  assert.match(skill, /Call the `workflow_script` tool \(find it with `tool_search`\) with exactly the `name` and `args` of that `call`/);
  assert.match(skill, /--wait-since <since>/);
  assert.match(skill, /Do not end your turn before it returns: the card is dropped when your turn ends/);
  assert.match(skill, /never try to start the run another way from your shell/);
  assert.match(skill, /Never give the user a command or a `\/workflows run` line to type/);
});

test('inside a MendCode session start-item does not call mendcode: it hands back the workflow_script call to make', () => {
  const { calls, run } = recorder(started);
  const result = startItem({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson, pause, env: { MENDCODE_AGENT_SHELL: '/data' }, now: () => 1000 }, run);
  assert.equal(calls.length, 0, 'the session shell is refused by MendCode, so it is never tried');
  assert.equal(result.started, false);
  assert.equal(result.insideMendcode, true);
  assert.equal(result.since, 1000);
  assert.match(result.next, /This is not an error and the user runs nothing/);
  assert.match(result.next, /--wait-since 1000/);
  assert.doesNotMatch(JSON.stringify(result), /only the user can start/, 'nothing tells the lead to hand the start to the user');
  assert.deepEqual(result.call, { tool: 'workflow_script', name: 'mend', args: workflowArgs({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson }) });
  const refusal = { ok: false, stdout: '', stderr: "error: A session may not change permissions, global settings or another session's authority from its own shell; only the user can." };
  const engineShell = startItem({ repo: '/repo', item: '.mend/items/low.json', pkg: '/pkg', readJson, pause, env: {}, now: () => 1000 }, recorder(refusal).run);
  assert.equal(engineShell.insideMendcode, true, 'another engine\'s shell has no variable; MendCode\'s refusal tells it apart');
  assert.deepEqual(engineShell.call, result.call);
  const held = startItem({ repo: '/repo', item: '.mend/items/risky.json', pkg: '/pkg', readJson, pause, env: { MENDCODE_AGENT_SHELL: '/data' } }, run);
  assert.match(held.reason, /high risk/, 'a high item still needs the user\'s yes before any card');
});

test('--wait-since finds the run the user approved: a mend workflow here, started since, whose tasks name the item', () => {
  const listing = (workflows) => ({ ok: true, stdout: JSON.stringify({ data: { workflows } }), stderr: '' });
  const other = { workflowId: 'wfl_old', name: 'mend', directory: '/repo', startedAt: 500, state: 'running', tasks: [{ label: 'spec low' }] };
  const neighbour = { workflowId: 'wfl_n', name: 'mend', directory: '/repo', startedAt: 2000, state: 'running', tasks: [{ label: 'spec lower' }] };
  const mine = { workflowId: 'wfl_2', name: 'mend', directory: '/repo', startedAt: 1500, state: 'running', tasks: [{ label: 'spec low' }] };
  const replies = [listing([other, neighbour]), listing([other, neighbour, mine])];
  const seen = [];
  const run = (command, args, cwd) => { seen.push([command, ...args, cwd].join(' ')); return replies.shift() ?? listing([]); };
  let clock = 1000;
  const result = waitForStart({ repo: '/repo', item: '.mend/items/low.json', since: 1000, pause: () => { clock += 10_000; }, now: () => clock }, run);
  assert.deepEqual(result, { started: true, item: '.mend/items/low.json', workflowId: 'wfl_2' });
  assert.ok(seen.every((call) => call === 'mendcode workflow list --limit 20 --json /repo'), 'only reads, which a session shell may do');
});

test('--wait-since gives up after its minutes when the card is never approved', () => {
  let clock = 0;
  const result = waitForStart({ repo: '/repo', item: '.mend/items/low.json', since: 0, minutes: 1, pause: () => { clock += 10_000; }, now: () => clock }, () => ({ ok: true, stdout: JSON.stringify({ data: { workflows: [] } }), stderr: '' }));
  assert.equal(result.started, false);
  assert.match(result.reason, /has not approved the workflow card/);
});
