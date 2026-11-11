#!/usr/bin/env node
// Workflow scripts cannot import modules. Keep prompt construction in a packaged
// CLI, reached through the same check bridge as rubric and critic-reply.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The critic runs read-only without a shell, so the exact diff is written where it can read it.
function pathspecFrom(diffPaths) {
  return [...String(diffPaths ?? '').matchAll(/'((?:[^']|'"'"')*)'/g)].map((match) => match[1].split(`'"'"'`).join("'"));
}

export function diffInstruction({ worktree, evidenceDir, from, to, diffPaths, name }) {
  const command = 'git diff ' + from + ' ' + to + (diffPaths ?? '');
  try {
    const diff = execFileSync('git', ['diff', '--no-color', '--no-ext-diff', from, to, '--', ...pathspecFrom(diffPaths)], { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const relative = evidenceDir + '/' + name + '-' + String(to).slice(0, 12) + '.patch';
    mkdirSync(path.dirname(path.join(worktree, relative)), { recursive: true });
    writeFileSync(path.join(worktree, relative), diff);
    return 'Read the full diff (excluding configured verification artifacts) in ' + relative + ' inside the worktree; it is the exact output of: ' + command;
  } catch {
    return 'Read the full diff yourself (excluding configured verification artifacts): ' + command;
  }
}

// The planner names what a ticket leaves implicit; cheap owners then build to that spec.
export const SPEC_REQUEST = 'You are the planner for this item. Read the repository in the worktree and the item. Do not edit, create or delete any file and do not commit. Write the implementation spec the owner will follow: the exact observable behaviour, including the edge cases and failure modes the item leaves implicit (concurrency and retries, boundaries, invalid input, other users and access, partial failure), status codes and error shapes consistent with the existing code, the mechanism to use where correctness depends on it, the files to change inside the editSet, and the tests that prove each point. Keep it inside the item\'s goal; do not add features. Reply as JSON {"spec": "<the spec as Markdown>"}.';

function baseContext({ pkg, item, plan, worktree, branch, verificationCommands }) {
  return [
    'Work item (JSON): ' + JSON.stringify(item),
    'Profiles: ' + plan.profiles.map((profile) => profile.kind).join(', ') + '. Round budget ' + plan.roundBudget + ', file cap ' + plan.fileCap + '.',
    'Worktree ' + worktree + ', branch ' + branch + '. Edit only there; cd there before every shell command; never git -C. You must run shell commands there yourself (tests, the regression, verification, git add/commit); "edit-only" in the playbooks means the lead\'s capture tool is off-limits, never that you cannot run commands.',
    'First read ' + pkg + '/skills/mend-quality/SKILL.md and ' + pkg + '/skills/mend-ship/SKILL.md.',
    'Before UI proposals read: ' + JSON.stringify(plan.uiReferences ?? []) + '. Suggested, not assigned, types: ' + JSON.stringify(plan.suggestedUiTypes ?? []) + '. Team design rules/exemplars override these fallbacks.',
    'Full repository verification (mandatory, not an item-selected subset): ' + JSON.stringify(verificationCommands),
  ].join('\n');
}

export function buildPrompts(kind, data) {
  const { pkg, item, plan, worktree, evidenceDir } = data;
  if (kind === 'spec') return baseContext(data) + '\n\n' + SPEC_REQUEST;
  if (kind === 'context') {
    const context = baseContext(data) + (typeof data.specPath === 'string' && data.specPath.trim()
      ? '\n\nImplementation spec from the planner: read ' + worktree + '/' + data.specPath + ' before anything else. It is part of the frozen plan and you never edit it; follow it, and raise a dispute with a reason where it is wrong instead of departing from it silently.'
      : '');
    const ownerReport = `End with '## Owner report' then one JSON line:
{"head":"<last commit sha>","exemplars":[{"label":"<short label>","path":"<path>","took":"<what you took>"}],
"commands":[{"name":"<name>","command":"<exact command>","log":"${evidenceDir}/<name>.log"}],
"proposals":["<each artifact path>"],"disputes":[{"id":"F<n>","reason":"<why wrong>"}],
"profileEvidence":{"<kind>":{"approvedProposal":"<this profile's proposal path, set even before approval>","exemplarPairs":[{"exemplar":"<path>","proposal":"<approved path>"}],"<declared card field>":"<evidence>"}},
"card":{"problem":"<what is wrong today>","drivenPath":{"steps":["..."],"artifacts":["..."]},"proof":{"changeType":"ui|backend|performance|bugfix|refactor|other","note":"<bugfix: the root cause as path:line and why it fails>"},
"notVerified":["..."],"notChanged":["... or none"],"uncertain":["... or none"],"rollback":"<how to undo>","riskRule":"<risk tier rule>"}}
Capture every command: { echo "$ <command>"; <command>; echo "exit: $?"; } > ${evidenceDir}/<name>.log 2>&1
Every report lists the exemplars you read, with unique labels and paths; repeat the ones cited in the proposal, never an empty list. An exemplar is an existing file this item does not edit; a file in the edit set is refused. Include every profile's declared cardFields under its kind in profileEvidence. Each proposal profile needs its own approvedProposal/exemplarPairs, never another profile's artifact. card.irreversible lists paths needing human countersigns.`;
    const proposals = plan.profiles.filter((profile) => profile.proposalArtifact);
    return {
      context, ownerReport,
      restate: context + '\n\nRestate the item in your own words, JSON only. Do not edit any file.',
      proposal: 'Read exemplars first (G1). Produce only these proposals, each at the exact path listed with it (the workflow reads them there), otherwise under ' + evidenceDir + '/proposal/; do not touch integration. Artifacts, commits and logs already in this worktree for this item come from an earlier attempt of this same task: they are yours, so verify them against the current HEAD and reuse or update them; never stop because they exist:\n' + proposals.map((profile) => '- ' + profile.kind + ': ' + profile.proposalArtifact.name + ' - ' + profile.proposalArtifact.what + (profile.proposalArtifact.inputs ?? []).map((input) => ' Save at ' + evidenceDir + '/' + input.path + '.').join('')).join('\n') + (proposals.some((profile) => profile.proposalArtifact.name === 'reproduction') ? '\nFor the reproduction only, create or edit and commit the regression test files in the item editSet that match test globs; do not edit any other tracked file. Run the declared regression command before fixing the bug. Report the reproduction artifact under ' + evidenceDir + '/proposal/reproduction.json; the workflow records the measured base run there.' : ''),
      planEvidence: 'Prepare proposal evidence for the item/restated plan at ' + evidenceDir + '/proposal-plan.json. Read/cite exemplars. Do not edit implementation or plan snapshot; human approval must precede integration.',
    };
  }
  if (kind === 'supervise') {
    return data.context + '\n\nSupervise before integration, read-only. Read every artifact/cited exemplar, not just the owner\'s summary. restatementMatches is true only if restated goal AND finish preserve the item\'s goal and EVERY acceptance line. ' + (data.noArtifacts ? 'Without artifacts, review the item/restated plan. ' : '') + 'Approve only if the proposal meets the item; otherwise give a concrete rejection reason.\nRestatement: ' + JSON.stringify(data.restatement) + '\nArtifacts: ' + JSON.stringify(data.approvedProposals) + '\nExemplars: ' + JSON.stringify(data.exemplars);
  }
  if (kind === 'owner') {
    const { proposalStage, feedback, approvedProposals } = data;
    const task = proposalStage ? 'Revise only the proposal artifacts, not the integration. Never edit proposal-plan.json in the item evidence folder: it is the workflow\'s frozen record of the restated item; put the planned fix and any detail a finding asks for into your proposal artifacts. ' + (data.redProposal ? 'You may also revise only the regression test files in the editSet matching test globs; commit them before measurement. The regression and full verification are expected to fail until integration: that is not a blocker, so report done once the artifacts are revised. ' : '') + (feedback ?? '') : feedback === null
      ? 'Implement the item' + (approvedProposals.length ? ' by integrating the approved proposal without changing it' : '') + '. Read the exemplars first (G1). Commit after each step whose checks pass. Files earlier rounds of this item committed in this worktree, the proposal\'s tests included, are yours to edit within the edit set, even if the tool says another session wrote them.'
      : 'Your previous round was sent back. Fix exactly this, nothing else:\n' + feedback;
    return task;
  }
  if (kind === 'critique') {
    const { baseSha, head, diffPaths, previousHead, open, report, expected, hasGrowth } = data;
    const laterRound = open.length > 0
      ? '\n\nOpen findings:\n' + open.map((finding) => '- ' + finding.id + ' [' + finding.severity + ']').join('\n') +
        '\nOwner notes: ' + JSON.stringify(report.disputes ?? []) + '\nDiff since the previous review: ' + diffInstruction({ worktree, evidenceDir, from: previousHead, to: head, diffPaths, name: 'critique-delta' })
      : '';
    return [
      'Follow ' + pkg + '/skills/mend-quality/critique-prompt.md exactly. Lenses: ' + data.lenses.join(', ') + '.',
      'Require a normal install without an extra service. D18: cut diff growth unexplained by open blocker/should findings before other work.',
      'Item: ' + JSON.stringify(item),
      'Worktree: ' + worktree + ' (cd into it; read only). Base ' + baseSha + ', head ' + head + '. Size: ' + data.stat.trim() + '.',
      diffInstruction({ worktree, evidenceDir, from: baseSha, to: head, diffPaths, name: 'critique-diff' }) + '\nDo not accept a summary in its place.',
      'Owner commands/logs: ' + JSON.stringify(report.commands ?? []),
      'Exemplars (each label is a score column): ' + JSON.stringify(report.exemplars ?? []),
      'Required score categories (exact ids): ' + JSON.stringify(expected.categories) + '. Explicit n/a heads need a not-applicable: <category> - <reason> line.',
      'Read all proposals/restated plan: ' + [data.snapshotPath, ...data.approvedProposals].join(', ') + '. Status: ' + (data.approved ? 'approved; check integration against it' : 'not yet approved; critique the proposal itself') + '. ' + data.snapshotPath + ' is the workflow\'s frozen record of the restated item, which the owner cannot change; aim findings about the planned fix at the proposal artifacts.',
      'The frozen record names the planner\'s implementation spec (a Markdown file in the evidence folder; read all of it): it is the contract for how the item works. Do not send a proposal back for lacking a mechanism or edge case the spec already gives; flag where the proposal or head departs from the spec, and where the spec itself is wrong or misses a case, say so as a finding against the spec.',
      'Read ' + evidenceDir + '/review-card.json (provisional evidence, not final delivery).',
      'Rubric and integrity results: ' + JSON.stringify(report.checkResults ?? {}),
      'Number new findings from ' + data.nextFinding + '.' + laterRound,
      ...(hasGrowth ? [
        'D18: read previous critique logs and the full diff since previous head. An open finding alone is NOT an explanation. Verify each hunk\'s lines are necessary for a listed open blocker/should, not unrelated expansion; distrust unchecked owner claims. Add: growth: {"hunks":[{"hunk":"<exact hunk key>","finding":"F<n>","reason":"<why these lines are necessary>"}]}. Omit unjustified hunks; omissions flag the lead.',
      ] : []),
    ].join('\n');
  }
  throw new Error('unknown prompt kind: ' + kind);
}

export function main(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  try {
    if (argv.length !== 2) throw new Error('usage: quality-prompts.mjs <kind> <json>');
    stdout.write(JSON.stringify({ prompt: buildPrompts(argv[0], JSON.parse(argv[1])) }) + '\n');
    return 0;
  } catch (error) {
    stderr.write('[QUALITY-PROMPTS]: ' + error.message + '\n');
    return 64;
  }
}

// Node canonicalizes the module URL, but argv may retain a symlinked path.
function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  const argv = process.argv.slice(2);
  // Keep this helper standalone for direct CLI use and symlinked installations.
  if (argv.length === 1 && argv[0] === '--stdin') {
    const { readFileSync } = await import('node:fs');
    process.exitCode = main(JSON.parse(readFileSync(0, 'utf8')).args);
  } else process.exitCode = main(argv);
}
