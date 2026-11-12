export const meta = {
  name: "mend-lite-pr",
  description: "Prove one item mend-lite reviewed: rerun its checks at head, integrity and red-green, a read-only auditor in its own session, then the evidence card for the pull request",
  phases: [
    { title: "Checks", detail: "checks, integrity, red-green at the reviewed head" },
    { title: "Audit", detail: "read-only auditor, not the owner or reviewer" },
    { title: "Card", detail: "light-path evidence card, schema-checked" },
  ],
  // The host pauses a run once its agent count reaches the cap, even at the last call: leave headroom.
  budget: { agents: 3, minutes: 60 },
  permission: "edits",
  maxConcurrent: 1,
}

// Arguments:
//   repo     absolute path of the user's repository (holds .mend/)
//   item     the work item JSON (.mend/items/<id>.json); mend-lite must have reviewed it
//   pkg      the installed mend-autopilot package folder; relative item/pkg resolve against repo
//   auditor  catalog id of the auditor's model; default: the strong reviewer mend-lite used
//   engine   optional, as in mend-lite
// The card says path "light": the strong review replaces profile rubrics and scored critique, and
// that gap is written into notVerified. The best state is merge-ready; a human approves the merge.

const js = JSON.stringify
const STR = { type: "string" }
const trimmed = (value) => typeof value === "string" ? value.trim() : ""
const RUNG_ORDER = ["investigate", "draft", "autopilot", "full"]

function required(name) {
  const value = trimmed(args[name])
  if (!value) throw new Error("[MEND-LITE-PR]: argument " + name + " is required")
  return value
}

function stopWith(state, reason, extra) {
  log("stop", state, reason)
  return Object.assign({ state, reason }, extra ?? {})
}

const repo = trimmed(args.repo)
if (!repo.startsWith("/")) return stopWith("blocked", "argument repo must be the repository's absolute path")
const repoPath = (value) => value.startsWith("/") ? value : repo + "/" + value
const pkg = repoPath(required("pkg"))
const itemPath = repoPath(required("item"))
const normalizeModel = (value) => value && !value.includes(":") ? value.replace("/", ":") : value
const engine = trimmed(args.engine) || null
if (engine && engine.startsWith("acp")) throw new Error("[MEND-LITE-PR]: workflows do not accept ACP")

const quote = (value) => "'" + String(value).split("'").join("'\"'\"'") + "'"
let policyBinding = null
const tool = (script, rest, text) => ({ command: "node " + quote(pkg + "/checks/" + script) + " --stdin", stdin: js({ args: rest, policy: policyBinding, text }) })
const host = (operation, data) => tool("workflow-host.mjs", [operation, js(data)])
const git = (values, cwd) => host("git", { args: values, cwd })

function jsonOutput(text) {
  const source = String(text ?? "").trim()
  try { return JSON.parse(source) } catch {}
  const start = source.search(/^\{/m)
  const end = source.lastIndexOf("}")
  if (start >= 0 && end > start) try { return JSON.parse(source.slice(start, end + 1)) } catch {}
  for (const line of source.split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue
    try { return JSON.parse(line.trim()) } catch { return null }
  }
  return null
}

async function run({ command, stdin }) {
  if (command.length > 300 || /[;&|<>`$\\\n\r]/.test(command)) throw new Error("package path cannot be represented by check()")
  const result = await check(command, { stdin })
  if (result.truncated) throw new Error("[MEND-LITE-PR]: output of a host command was truncated by the runtime: " + command.slice(0, 120))
  const detail = String(result.detail ?? "").replace(/^exit -?\d+\n?/, "")
  return { ok: result.ok, detail, json: jsonOutput(detail) }
}

async function writeText(file, text) {
  const result = await run(tool("write-file.mjs", [file], text))
  if (!result.ok) throw new Error("[MEND-LITE-PR]: could not write " + file + ": " + result.detail.slice(-300))
}
async function appendText(file, text) {
  const result = await run(tool("write-file.mjs", [file, "--append"], text))
  if (!result.ok) throw new Error("[MEND-LITE-PR]: could not append " + file)
}
async function readJson(file) {
  const result = await run(host("read-json", { file }))
  return result.ok ? result.json : null
}
const lastLine = (text) => String(text ?? "").trim().split("\n").pop() ?? ""
const lower = (order, left, right) => order[Math.min(order.indexOf(left), order.indexOf(right))]

phase("Checks")

const top = await run(git(["rev-parse", "--show-toplevel"], repo))
const repoRoot = lastLine(top.detail)
if (!top.ok || !repoRoot.startsWith("/")) return stopWith("blocked", "could not resolve the repository root: " + top.detail.slice(-300))
const item = await readJson(itemPath)
if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.id)) return stopWith("blocked", "the item file " + itemPath + " is missing or has no valid id")
const worktree = repoRoot + "/.mend/worktrees/" + item.id
const branch = "mend/" + item.id
const evidenceDir = ".mend/evidence/" + item.id
const evidencePath = (name) => worktree + "/" + evidenceDir + "/" + name
const stopHere = (state, reason, extra) => stopWith(state, reason, { worktree, branch, ...extra })
const inWorktree = (values) => run(git(values, worktree))

const state = await readJson(evidencePath("lite-state.json"))
const liteCard = await readJson(evidencePath("lite-card.json"))
const lastRound = Array.isArray(state?.rounds) ? state.rounds.at(-1) : null
if (!state || state.item !== item.id || !/^[0-9a-f]{40}$/.test(state.baseSha ?? "") || !lastRound) return stopHere("draft", "run mend-lite first: no valid mend-lite state for " + item.id)
if (liteCard?.state !== "reviewed" || lastRound.review?.verdict !== "merge" || liteCard.head !== lastRound.head) return stopHere("draft", "run mend-lite first: " + item.id + " is not reviewed at its last head")
const baseSha = state.baseSha
const head = lastLine((await inWorktree(["rev-parse", "HEAD"])).detail)
if (head !== liteCard.head) return stopHere("draft", "the head moved from " + liteCard.head + " to " + head + " after review; run mend-lite again")
if (!state.reviewPolicy) return stopHere("blocked", "the captured review policy is missing; run mend-lite again")
policyBinding = state.reviewPolicy
const reviewPolicy = await run(tool("review-policy.mjs", [worktree, baseSha]))
if (!reviewPolicy.ok || !Array.isArray(reviewPolicy.json?.pathspec)) return stopHere("blocked", "could not load the review exclusions: " + reviewPolicy.detail.slice(-300))
const pathspec = reviewPolicy.json.pathspec
// The owner may have removed the untracked setup; restore it so the checks run what was recorded. Its
// untracked copies are this workflow's, not changes to the reviewed head.
const restored = await run(tool("dispatch.mjs", ["propagate", "--repo", repoRoot, "--item", itemPath, "--light", "yes"]))
if (!restored.ok || restored.json?.pass !== true) return stopHere("blocked", "could not restore the worktree setup: " + (restored.json?.reason ?? restored.detail.slice(-300)))
const setupPaths = new Set(Array.isArray(restored.json.setup) ? restored.json.setup.map(String) : [])
const unexpected = (porcelain) => String(porcelain).split("\n").filter((line) => line.trim() && !(line.startsWith("?? ") && setupPaths.has(line.slice(3).trim()))).join("\n")
async function checkoutProblem() {
  const current = await inWorktree(["rev-parse", "HEAD"])
  if (!current.ok || lastLine(current.detail) !== head) return "the worktree head moved or could not be read; run mend-lite again"
  const status = await inWorktree(["status", "--porcelain", "--untracked-files=all", "--", ...pathspec])
  if (!status.ok || unexpected(status.detail) !== "") return "the worktree is dirty or its status could not be read; restore a clean checkout before verification"
  return null
}
const initialProblem = await checkoutProblem()
if (initialProblem) return stopHere("blocked", initialProblem)

const authorization = await run(tool("dispatch.mjs", ["delivery", "--repo", repoRoot, "--item", itemPath, "--base", baseSha, "--head", head, "--light", "yes"]))
if (!authorization.ok || authorization.json?.pass !== true) return stopHere("blocked", authorization.json?.reason ?? "delivery authorization failed")

const verification = await readJson(repoRoot + "/.mend/evidence/verify.json")
if (!Array.isArray(verification?.steps) || !verification.steps.length || verification.steps.some((step) => !trimmed(step?.command) || step.exit !== 0)) return stopHere("blocked", "the verification record must list every passing verification command")
const itemChecks = [...new Set([...(Array.isArray(item.checks) ? item.checks.map(String) : []), ...verification.steps.map((step) => step.command.trim())])]
const regression = [item.regressionCommand, item.regression].map(trimmed).find(Boolean) ?? ""
for (const command of [...itemChecks, ...(regression ? [regression] : [])]) {
  const guard = await run(host("guard", { cwd: worktree, command }))
  if (!guard.ok) return stopHere("blocked", "the guard refuses an item command: " + guard.detail.trim().slice(-300))
}
const checks = []
for (let index = 0; index < itemChecks.length; index += 1) {
  const command = itemChecks[index]
  const logFile = evidenceDir + "/pr-check-" + (index + 1) + ".log"
  const executed = await run(host("execute", { cwd: worktree, command, file: logFile }))
  const captured = await run(host("read", { cwd: worktree, file: logFile }))
  const match = /(?:^|\n)exit: (\d+)\s*$/.exec(captured.detail)
  checks.push({ name: "check-" + (index + 1), command, cwd: ".", exit: executed.ok && captured.ok && match ? Number(match[1]) : 1, log: logFile })
  const problem = await checkoutProblem()
  if (problem) return stopHere("blocked", problem)
}

const integrityRun = await run(tool("integrity.mjs", ["--base", baseSha, "--head", head, "--item", itemPath, "--repo", worktree, "--json"]))
const report = integrityRun.json
const validFlags = Array.isArray(report?.flags) && report.flags.every((flag) => flag && trimmed(flag.rule) && trimmed(flag.file) && Number.isInteger(flag.line) && flag.line >= 0 && typeof flag.detail === "string" && (flag.severity === "warn" || flag.severity === "block"))
if (!validFlags || typeof report.pass !== "boolean") return stopHere("blocked", "the integrity scan failed or returned an invalid report: " + integrityRun.detail.slice(-300))
const flags = report.flags.map(({ rule, file, line, detail, severity }) => ({ rule, file, line, detail, severity }))

let redGreen = null
if (regression) {
  const setup = trimmed(item.regressionSetup)
  const keep = trimmed(item.regressionKeep)
  const expectBase = typeof item.regressionExpect === "string" ? item.regressionExpect : ""
  const timeoutMs = Number.isFinite(item.regressionTimeoutMs) && item.regressionTimeoutMs > 0 ? item.regressionTimeoutMs : 0
  const options = [...(setup ? ["--setup", setup] : []), ...(keep ? ["--keep", keep] : []), ...(expectBase ? ["--expect-base", expectBase] : []), ...(timeoutMs ? ["--timeout-ms", String(timeoutMs)] : [])]
  const result = await run(tool("red-green.mjs", ["--base", baseSha, "--head", head, "--cmd", regression, "--repo", worktree, "--item", itemPath, ...options, "--json"]))
  if (!result.json || result.json.pass !== true) return stopHere("blocked", "red-green did not pass: " + String(result.json?.reason ?? result.detail).slice(-500))
  redGreen = { command: regression, baseSha, baseExit: result.json.base?.exit ?? result.json.baseExit, headSha: head, headExit: result.json.head?.exit ?? result.json.headExit, ...(keep ? { keep: result.json.keep } : {}), ...(setup ? { setup } : {}), ...(expectBase ? { expectBase } : {}), ...(timeoutMs ? { timeoutMs } : {}) }
}
const patchId = lastLine((await run(host("patch-id", { cwd: worktree, base: baseSha, head }))).detail).split(" ")[0]
const beforeAudit = await checkoutProblem()
if (beforeAudit) return stopHere("blocked", beforeAudit)

phase("Audit")

const critic = trimmed(state.critic) || trimmed(liteCard.critic)
const auditorModel = normalizeModel(trimmed(args.auditor)) || critic || null
if (engine && engine !== "native" && !auditorModel) return stopHere("blocked", "an auditor on engine " + engine + " needs an exact model: pass auditor")
const auditRun = await agent(
  [
    "You are the auditor of work item " + item.id + ". You did not write it and you did not review it. Run whatever you need, including the repository's own verification even when it writes logs, evidence or temporary files under ignored paths (.mend/, /tmp). Do not edit tracked files and make no commit: the workflow blocks the audit if the head moves or a tracked or new unignored file appears.",
    "Worktree " + worktree + " (cd into it). Base " + baseSha + ", head " + head + ".",
    "Item: " + js({ goal: item.goal, acceptance: item.acceptance ?? [], editSet: item.editSet ?? [], checks: itemChecks }),
    "The spec the owner built from is " + evidenceDir + "/spec.md. Read the full diff (git diff " + baseSha + " " + head + " -- " + pathspec.map(quote).join(" ") + ").",
    "Rerun every item check yourself at head. Then drive the changed behaviour end to end yourself (run the code path, a request, or the test that exercises it) and list each step you drove in drivenSteps, in order.",
    "Return lanes named exactly checks and driven-path, with the concrete method for each. If you could not drive the behaviour, mark driven-path MISSING or BLOCKED, never PASS.",
    "Report PASS only if every acceptance line is met at this head and every check you ran exits 0. ISSUES names each problem with file:line. BLOCKED names what you could not run.",
    "Judge the change, not your own tooling. A driver or script you wrote that fails because of itself (a missing import alias, a browser you lack, an assertion of yours that contradicts the spec) is not a problem of the change: repair it or drive the path another way, judge from the run that works, and put the failed attempts in attention, not in ISSUES. The item checks above are different: one that exits non-zero is always ISSUES.",
    "When an acceptance line is visual (how something looks or moves on screen) and you cannot look at the rendered result, drive the code that produces it (state, render or layout functions, pixel buffers) and judge from that; list the look you could not see in notVerified for the human. A visual check you could not do is never by itself ISSUES or BLOCKED, and you always return the report instead of stopping.",
    "Also read the diff as a maintainer would. Put each serious maintainability problem the review let through in attention with file:line and the fix: logic that duplicates an existing helper (name it), a pattern the same file uses ignored, a function grown much harder instead of extracted, dead or leftover code. These go to the human; they are not ISSUES unless they break an acceptance line.",
  ].join("\n"),
  {
    label: "audit " + item.id,
    phase: "Audit",
    // The host's read mode has no shell, and the auditor must rerun the checks; checkoutProblem() after
    // the audit is what keeps it read-only.
    mode: "work",
    detail: true,
    ...(auditorModel ? { model: auditorModel } : {}),
    ...(engine ? { engine } : {}),
    schema: {
      type: "object",
      required: ["result", "lanes", "notVerified", "drivenSteps"],
      properties: {
        result: { type: "string", enum: ["PASS", "ISSUES", "BLOCKED"] },
        lanes: { type: "array", minItems: 1, items: { type: "object", required: ["lane", "result", "method"], properties: { lane: STR, result: { type: "string", enum: ["PASS", "ISSUES", "BLOCKED", "MISSING"] }, method: STR } } },
        drivenSteps: { type: "array", items: STR },
        notVerified: { type: "array", items: STR },
        attention: { type: "array", items: STR },
      },
    },
  },
).catch((error) => {
  // An auditor that ends blocked is a result to report, not a crash of the run.
  if (!/\) failed: blocked:/.test(String(error?.message))) throw error
  return { stopped: String(error.message).replace(/^.*?failed: blocked:\s*/s, "").slice(0, 600) }
})
if (auditRun?.stopped) return stopHere("blocked", "the auditor stopped before a verdict: " + auditRun.stopped)
// With detail, the host returns the schema-validated object as value and the agent's prose as text.
const audit = auditRun?.value && typeof auditRun.value === "object" ? auditRun.value : jsonOutput(auditRun?.text)
const auditorSession = trimmed(auditRun?.taskId)
if (!audit || !Array.isArray(audit.lanes) || !Array.isArray(audit.notVerified)) return stopHere("blocked", "the auditor returned an invalid structured report")
const ownerSessions = state.rounds.map((round) => trimmed(round.ownerSession)).filter(Boolean)
if (!auditorSession || ownerSessions.includes(auditorSession)) return stopHere("blocked", "the auditor needs its own session, distinct from every owner session")
const afterAudit = await checkoutProblem()
if (afterAudit) return stopHere("blocked", afterAudit)

phase("Card")

const drivenSteps = (Array.isArray(audit.drivenSteps) ? audit.drivenSteps : []).map(String).filter((step) => step.trim())
const requiredLanes = ["checks", "driven-path"]
const auditPass = audit.result === "PASS" && drivenSteps.length > 0 && requiredLanes.every((name) => audit.lanes.some((lane) => lane.lane === name && lane.result === "PASS" && trimmed(lane.method))) && audit.lanes.every((lane) => lane.result === "PASS")
const allChecksPass = checks.every((entry) => entry.exit === 0)
const blocking = flags.filter((flag) => flag.severity === "block")
const reviewed = state.rounds.filter((round) => round.review && /^[0-9a-f]{40}$/.test(round.head ?? ""))
const review = {
  critic: String(critic || "workflow role"),
  verdict: lastRound.review.verdict,
  rounds: reviewed.map((round) => ({
    round: round.round,
    head: round.head,
    verdict: round.review.verdict,
    summary: String(round.review.summary ?? ""),
    ...(round.diff ? { diff: String(round.diff) } : {}),
    findings: (round.review.findings ?? []).map((finding) => ({ severity: finding.severity === "blocker" ? "blocker" : "nit", file: String(finding.file ?? ""), issue: String(finding.issue ?? "") || "(no text)" })),
  })),
}
const rejectedBy = state.rounds.slice(0, -1).map((round) => (round.review?.verdict === "fix" ? "critique" : "rubric"))
if (!auditPass && (audit.result === "ISSUES" || audit.lanes.some((lane) => lane.result === "ISSUES"))) rejectedBy.push("auditor")
const kinds = Array.isArray(item.profiles) && item.profiles.length ? [...new Set(item.profiles.map(String))] : ["generic"]
const skipReason = "light path: no profile rubric or scored critique; covered by repository verification, integrity, red-green when declared and the strong review"
const notVerified = [...new Set([
  "Profile rubrics and scored critique did not run (light path): " + kinds.join(", "),
  ...audit.notVerified.map(String),
  ...(Array.isArray(audit.attention) ? audit.attention.map((flag) => "Auditor attention: " + String(flag)) : []),
  ...flags.filter((flag) => flag.rule === "test-edit" && flag.severity === "warn").map((flag) => "Existing test changed as the item declares; read it before merging: " + flag.file + " (" + flag.detail + ")"),
  ...review.rounds.flatMap((round) => round.findings.filter((finding) => finding.severity === "nit").map((finding) => "Reviewer nit left for the human: " + finding.file + ": " + finding.issue)),
])]
const decisionLog = evidenceDir + "/decisions.tsv"
const logExists = await run(host("exists", { cwd: worktree, file: decisionLog }))
if (!logExists.ok) await writeText(worktree + "/" + decisionLog, "ts\tphase\tdecision\twhy\tevidence\tresult\n")
await appendText(worktree + "/" + decisionLog, [new Date().toISOString(), "audit", "verdict " + audit.result, "auditor " + auditorSession + " at head " + head, "mend-lite-pr audit lanes", audit.result].join("\t") + "\n")

const isBugfix = item.type === "bugfix" || kinds.includes("bugfix")
const rung = blocking.length ? lower(RUNG_ORDER, authorization.json.rung, "draft") : authorization.json.rung
const card = {
  schemaVersion: "1",
  path: "light",
  item: item.id,
  problem: String(item.problem ?? item.goal),
  goal: String(item.goal),
  state: "draft",
  rung,
  grant: authorization.json.grant,
  risk: { tier: authorization.json.tier, rule: String(authorization.json.riskRule ?? item.riskRule ?? "the item's declared risk") },
  owner: { model: String(liteCard.owner ?? "workflow role"), ...(ownerSessions.length ? { session: ownerSessions.at(-1) } : {}) },
  branch,
  baseSha,
  headSha: head,
  checks,
  drivenPath: { steps: drivenSteps, artifacts: checks.map((entry) => entry.log) },
  proof: isBugfix ? { changeType: "bugfix", note: "red-green: the regression fails at base and passes at head" } : { changeType: "other", note: "light path: the checks and the auditor's driven steps are the proof; no before/after figures were captured" },
  profiles: kinds.map((kind) => ({ kind, skipped: true, skipReason })),
  review,
  integrity: { pass: blocking.length === 0, flags, countersigned: [] },
  ...(redGreen ? { redGreen } : {}),
  rounds: { used: rejectedBy.length, budget: Math.max(1, Number(state.budget) || state.rounds.length), rejectedBy },
  verdict: { result: audit.result, sha: head, patchId, author: ownerSessions.at(-1) ?? "owner " + String(liteCard.owner ?? "workflow role"), verifier: auditorSession, verifierModel: String(auditorModel ?? "workflow role") },
  auditLanes: audit.lanes.map((lane) => ({ lane: String(lane.lane), result: lane.result, sha: head, method: String(lane.method) })),
  decisionLog,
  notVerified,
  notChanged: ["none"],
  uncertain: ["none"],
  rollback: "revert the merge commit",
  countersigns: [],
  flaky: [],
}

// Workflow scripts cannot load modules: the secret scan and the schema run in card-check.mjs.
const cardPath = worktree + "/.mend/evidence/" + item.id + ".json"
async function cardCheck() {
  await writeText(cardPath, js(card, null, 2))
  const result = await run(tool("card-check.mjs", [cardPath, worktree, baseSha]))
  return result.ok && Array.isArray(result.json?.failures) ? result.json : { secret: null, failures: [{ target: "(card)", rule: "card-schema", detail: "card check failed: " + result.detail.slice(-300) }] }
}
if (allChecksPass && auditPass && card.integrity.pass && review.verdict === "merge") card.state = "merge-ready"
let checked = await cardCheck()
if (checked.secret) {
  card.integrity.flags.push({ rule: "secret-like", file: "(card)", line: 0, detail: checked.secret + " in composed evidence card; value withheld", severity: "block" })
  card.integrity.pass = false
  card.rung = lower(RUNG_ORDER, card.rung, "draft")
  card.state = "draft"
  checked = await cardCheck()
}
const schemaFailures = checked.failures
if (schemaFailures.length && card.state !== "draft") {
  card.state = "draft"
  await writeText(cardPath, js(card, null, 2))
}

const reasons = []
if (!allChecksPass) reasons.push("a check exited non-zero")
if (!auditPass) reasons.push("the auditor reported " + audit.result + (drivenSteps.length ? "" : " and drove nothing"))
if (!card.integrity.pass) reasons.push("integrity flags block delivery")
if (schemaFailures.length) reasons.push("card schema validation failed")
// What the auditor found goes back to the owner as one more round (mend.js), so a fixable finding does not end the item.
const auditFindings = auditPass ? null : [
  ...audit.lanes.filter((lane) => lane.result !== "PASS").map((lane) => lane.lane + " " + lane.result + ": " + String(lane.method)),
  ...checks.filter((entry) => entry.exit !== 0).map((entry) => "check exited " + entry.exit + ": " + entry.command),
  ...(Array.isArray(audit.attention) ? audit.attention.map(String) : []),
].join("\n").slice(0, 6000)
return stopHere(card.state, reasons.length ? reasons.join("; ") : "checks, integrity and the auditor pass at " + head + "; a human approves the merge", { card: cardPath, verdict: card.verdict, risk: card.risk, cardFailures: schemaFailures, ...(auditFindings && card.integrity.pass ? { auditFindings } : {}) })
