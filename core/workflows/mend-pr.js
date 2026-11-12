export const meta = {
  name: "mend-pr",
  description: "Verify one critiqued mend-autopilot item at its head: contract checks, integrity scan, red-green when declared, a read-only auditor in its own session, then the evidence card",
  phases: [
    { title: "Checks", detail: "contract checks, integrity, red-green" },
    { title: "Audit", detail: "read-only auditor, not the owner" },
    { title: "Card", detail: "write the card, rerun the card checks" },
  ],
  budget: { agents: 3, minutes: 90 },
  permission: "edits",
  maxConcurrent: 1,
}

// Arguments:
//   repo     absolute path of the user's repository, not check's scratch worktree
//   item     the work item JSON (.mend/items/<id>.json); mend-quality must have finished it
//   pkg      the installed mend-autopilot package folder; relative item/pkg paths resolve against repo
//   auditor  optional catalog id for the auditor; default: the model mend-quality's owners used, or the workflow role
// The engine comes from mend-quality's result, so the auditor runs where the owners ran.
// The PR itself is opened by the lead with the mend-ship skill; this workflow only proves and records.

const RUNG_ORDER = ["investigate", "draft", "autopilot", "full"]
const TIER_ORDER = ["low", "medium", "high"]

function required(name) {
  const value = args[name]
  if (typeof value !== "string" || value.trim() === "") throw new Error("[MEND-PR]: argument " + name + " is required")
  return value.trim()
}

const repo = typeof args.repo === "string" ? args.repo.trim() : ""
if (!repo) return stopWith("blocked", "argument repo is required: pass the absolute path of the user's repository")
if (!repo.startsWith("/")) return stopWith("blocked", "argument repo must be an absolute path")
const repoPath = (value) => value.startsWith("/") ? value : repo + "/" + value
const pkg = repoPath(required("pkg"))
const itemPath = repoPath(required("item"))
const quote = (value) => "'" + String(value).split("'").join("'\"'\"'") + "'"
let policyBinding = null
const tool = (script, rest, text) => ({ command: "node " + quote(pkg + "/checks/" + script) + " --stdin", stdin: JSON.stringify({ args: rest, policy: policyBinding, text }) })
const host = (operation, data) => tool("workflow-host.mjs", [operation, JSON.stringify(data)])
const git = (values, cwd) => host("git", { args: values, cwd })

function lastJsonLine(text) {
  const lines = String(text ?? "").trim().split("\n")
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith("{")) continue
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }
  return null
}

// The core CLIs print either one JSON line or one pretty-printed JSON document.
// Warnings on stderr may surround the document, so the block from the first line opening with "{" to the
// last "}" is tried too.
function jsonOutput(text) {
  const source = String(text ?? "")
  const start = source.search(/^\{/m)
  const end = source.lastIndexOf("}")
  for (const candidate of [source.trim(), start >= 0 && end > start ? source.slice(start, end + 1) : ""]) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch {}
  }
  return lastJsonLine(source)
}

async function run({ command, stdin }) {
  if (command.length > 300 || /[;&|<>`$\\\n\r]/.test(command)) throw new Error("package path cannot be represented by check()")
  const result = await check(command, { stdin })
  if (result.truncated) throw new Error("[MEND-PR]: output of a host command was truncated by the runtime: " + command.slice(0, 120))
  const detail = String(result.detail ?? "").replace(/^exit -?\d+\n?/, "")
  return { ok: result.ok, detail, json: jsonOutput(detail) }
}

const lastLine = (text) => String(text ?? "").trim().split("\n").pop() ?? ""

async function writeText(file, text) {
  const result = await run(tool("write-file.mjs", [file], text))
  if (!result.ok) throw new Error("[MEND-PR]: could not write " + file + ": " + result.detail.slice(-300))
}

async function appendText(file, text) {
  const result = await run(tool("write-file.mjs", [file, "--append"], text))
  if (!result.ok) throw new Error("[MEND-PR]: could not append " + file)
}

async function readJson(file) {
  const result = await run(host("read-json", { file }))
  return result.ok ? result.json : null
}

function stopWith(state, reason, extra) {
  log("stop", state, reason)
  return Object.assign({ state, reason }, extra ?? {})
}

const lower = (order, left, right) => order[Math.min(order.indexOf(left), order.indexOf(right))]
const higher = (order, values) => values.filter((value) => order.includes(value)).reduce((top, value) => (order.indexOf(value) > order.indexOf(top) ? value : top), order[0])

// ---------------------------------------------------------------------------
phase("Checks")

const top = await run(git(["rev-parse", "--show-toplevel"], repo))
const repoRoot = lastLine(top.detail)
if (!top.ok || !repoRoot.startsWith("/")) return stopWith("blocked", "could not resolve the repository root from argument repo: " + top.detail.slice(-300))
const item = await readJson(itemPath)
if (!item || typeof item.id !== "string") return stopWith("blocked", "the item file " + itemPath + " is missing or has no id")
const preflight = await run(tool("dispatch.mjs", ["preflight", "--repo", repoRoot, "--item", itemPath]))
if (!preflight.ok || preflight.json?.pass !== true) return stopWith("blocked", preflight.json?.reason ?? "dispatch preflight failed")
const worktree = repoRoot + "/.mend/worktrees/" + item.id
const evidenceDir = ".mend/evidence/" + item.id
const quality = await readJson(worktree + "/" + evidenceDir + "/quality.json")
if (!quality || quality.state !== "critiqued") return stopWith("draft", "run mend-quality first: no critiqued result for " + item.id)
const receipt = await readJson(repoRoot + "/.mend/approvals/" + item.id + ".json")
async function verifyApproval() {
  if (receipt?.item !== item.id || !receipt.quality?.length) return "approval receipt is missing; run mend-quality again"
  const inputs = [...receipt.quality, ...(receipt.proposal?.inputs ?? [])]
  const checked = await run(tool("approval.mjs", ["verify", worktree, JSON.stringify(inputs)]))
  if (!checked.ok || !checked.json?.pass) return checked.json?.error ?? "approval verification failed"
  const snapshot = receipt.proposal?.inputs?.find((input) => input.path === evidenceDir + "/proposal-plan.json")
  if (snapshot) {
    const approved = await readJson(worktree + "/" + snapshot.path)
    const current = await readJson(itemPath)
    if (!approved?.item || !current || JSON.stringify(approved.item) !== JSON.stringify(current)) return "approved item changed; reapproval required"
  }
  return null
}
const approvalFailure = await verifyApproval()
if (approvalFailure) return stopWith("draft", approvalFailure)
const head = lastLine((await run(git(["rev-parse", "HEAD"], worktree))).detail)
if (head !== quality.headSha) return stopWith("draft", "the head moved from " + quality.headSha + " to " + head + " after critique; run mend-quality again")
const baseSha = quality.baseSha
const authorization = await run(tool("dispatch.mjs", ["delivery", "--repo", repoRoot, "--item", itemPath, "--base", baseSha, "--head", head, "--prior-rung", quality.rung ?? "draft"]))
if (!authorization.ok || authorization.json?.pass !== true) return stopWith("blocked", authorization.json?.reason ?? "delivery authorization failed")
const inWorktree = (values) => git(values, worktree)
if (!quality.reviewPolicy) return stopWith("blocked", "the captured review policy is missing; run mend-quality again")
policyBinding = quality.reviewPolicy
const reviewPolicy = await run(tool("review-policy.mjs", [worktree, baseSha]))
if (!reviewPolicy.ok || !Array.isArray(reviewPolicy.json?.pathspec)) return stopWith("blocked", "could not load the review exclusions: " + reviewPolicy.detail)
const diffPaths = " -- " + reviewPolicy.json.pathspec.map(quote).join(" ")
async function checkoutProblem() {
  const policy = await run(tool("review-policy.mjs", [worktree, baseSha]))
  if (!policy.ok) return "review policy changed after capture; recover trusted configuration before continuing"
  const current = await run(inWorktree(["rev-parse", "HEAD"]))
  if (!current.ok || lastLine(current.detail) !== head) return "the worktree head moved or could not be read; run mend-quality again"
  const status = await run(inWorktree(["status", "--porcelain", "--untracked-files=all", "--", ...reviewPolicy.json.pathspec]))
  if (!status.ok || status.detail.trim() !== "") return "the worktree is dirty or its status could not be read; restore a clean checkout before verification"
  return null
}
const initialProblem = await checkoutProblem()
if (initialProblem) return stopWith("blocked", initialProblem)
const stateFile = worktree + "/" + evidenceDir + "/round-state.json"
const roundState = await readJson(stateFile)
if (!roundState || roundState.item !== item.id || roundState.baseSha !== baseSha || !Array.isArray(roundState.rejectedBy) || !Array.isArray(quality.rounds?.rejectedBy)) return stopWith("blocked", "the saved round state is missing or invalid; recover it before audit")
if (JSON.stringify(roundState.rejectedBy) !== JSON.stringify(quality.rounds.rejectedBy)) return stopWith("draft", "the round state changed after quality; run mend-quality again")

// check() runs outside the permission system, so the package hook never sees these commands. Each one the
// item supplies goes through the same guard first, with the payload a PreToolUse hook would get.
async function guardRefusal(command) {
  const verdict = await run(host("guard", { cwd: worktree, command }))
  return verdict.ok ? null : verdict.detail.trim()
}

const checks = []
const verification = await readJson(repoRoot + "/.mend/evidence/verify.json")
if (!Array.isArray(verification?.steps) || verification.steps.length === 0 || verification.steps.some((step) => typeof step?.command !== "string" || !step.command.trim() || step.exit !== 0)) return stopWith("blocked", "the verification record must contain every successful verification command")
const itemChecks = [...new Set([...(Array.isArray(item.checks) ? item.checks.map(String) : []), ...verification.steps.map((step) => step.command)])]
const regression = [item.regressionCommand, item.regression].find((value) => typeof value === "string" && value.trim() !== "")?.trim() ?? ""
for (const command of [...itemChecks, ...(regression ? [regression] : [])]) {
  const refusal = await guardRefusal(command)
  if (refusal) return stopWith("blocked", "the guard refuses an item command: " + refusal)
}
for (let index = 0; index < itemChecks.length; index += 1) {
  const command = itemChecks[index]
  const logFile = evidenceDir + "/check-" + (index + 1) + ".log"
  const executed = await run(host("execute", { cwd: worktree, command, file: logFile }))
  if (!executed.ok) return stopWith("blocked", "could not capture an item command: " + executed.detail)
  const exitLine = lastLine((await run(host("tail", { cwd: worktree, file: logFile }))).detail)
  const match = /^exit: (\d+)$/.exec(exitLine)
  checks.push({ name: "check-" + (index + 1), command, cwd: ".", exit: match ? Number(match[1]) : 1, log: logFile })
  const problem = await checkoutProblem()
  if (problem) return stopWith("blocked", problem)
}
for (const claimed of quality.commands ?? []) {
  if (!claimed?.log || !claimed?.command) continue
  const exitLine = lastLine((await run(host("tail", { cwd: worktree, file: claimed.log }))).detail)
  const match = /^exit: (\d+)$/.exec(exitLine)
  checks.push({ name: String(claimed.name ?? "owner"), command: String(claimed.command), cwd: ".", exit: match ? Number(match[1]) : 1, log: String(claimed.log) })
}

const integrityRun = await run(tool("integrity.mjs", ["--base", baseSha, "--head", head, "--item", itemPath, "--repo", worktree, "--json"]))
const report = integrityRun.json
const validFlags = Array.isArray(report?.flags) && report.flags.every((flag) => flag && typeof flag.rule === "string" && flag.rule.length > 0 && typeof flag.file === "string" && flag.file.length > 0 && Number.isInteger(flag.line) && flag.line >= 0 && typeof flag.detail === "string" && (flag.severity === "warn" || flag.severity === "block"))
if (!validFlags || typeof report.pass !== "boolean" || report.pass !== !report.flags.some((flag) => flag.severity === "block") || integrityRun.ok !== report.pass) return stopWith("blocked", "the integrity scan failed or returned an invalid report: " + integrityRun.detail.slice(-300))
const flags = report.flags.map((flag) => ({ rule: flag.rule, file: flag.file, line: flag.line, detail: flag.detail, severity: flag.severity }))
const countersigns = Array.isArray(quality.countersigns) ? quality.countersigns : []
const countersigned = flags
  .filter((flag) => countersigns.some((sign) => sign.subject === flag.rule + " " + flag.file + ":" + flag.line))
  .map((flag) => ({ rule: flag.rule, file: flag.file, line: flag.line }))
const blockingFlags = flags.filter((flag) => flag.severity === "block" && !countersigned.some((ref) => ref.rule === flag.rule && ref.file === flag.file && ref.line === flag.line))

let redGreen = null
if (regression !== "") {
  const redGreenArgs = ["--base", baseSha, "--head", head, "--cmd", regression, "--repo", worktree, "--item", itemPath]
  const redGreenSetup = typeof item.regressionSetup === "string" && item.regressionSetup.trim() !== "" ? item.regressionSetup.trim() : undefined
  const redGreenKeep = item.regressionKeep
  const redGreenExpect = typeof item.regressionExpect === "string" ? item.regressionExpect : undefined
  const redGreenTimeout = Number.isFinite(item.regressionTimeoutMs) && item.regressionTimeoutMs > 0 ? item.regressionTimeoutMs : undefined
  if (redGreenSetup !== undefined) redGreenArgs.push("--setup", redGreenSetup)
  if (redGreenKeep !== undefined) redGreenArgs.push("--keep", redGreenKeep)
  if (redGreenExpect !== undefined) redGreenArgs.push("--expect-base", redGreenExpect)
  if (redGreenTimeout !== undefined) redGreenArgs.push("--timeout-ms", String(redGreenTimeout))
  redGreenArgs.push("--json")
  const result = await run(tool("red-green.mjs", redGreenArgs))
  if (!result.json || result.json.pass !== true) return stopWith("blocked", "red-green did not pass: " + String(result.json?.reason ?? result.detail).slice(-500))
  redGreen = {
    command: regression,
    baseSha,
    baseExit: result.json.base?.exit ?? result.json.baseExit,
    headSha: head,
    headExit: result.json.head?.exit ?? result.json.headExit,
    ...(redGreenKeep !== undefined ? { keep: result.json.keep } : {}),
    ...(redGreenSetup !== undefined ? { setup: redGreenSetup } : {}),
    ...(redGreenExpect !== undefined ? { expectBase: redGreenExpect } : {}),
    ...(redGreenTimeout !== undefined ? { timeoutMs: redGreenTimeout } : {}),
  }
}

const patchLine = lastLine((await run(host("patch-id", { cwd: worktree, base: baseSha, head }))).detail)
const patchId = patchLine.split(" ")[0]
const beforeAuditProblem = await checkoutProblem()
if (beforeAuditProblem) return stopWith("blocked", beforeAuditProblem)

// ---------------------------------------------------------------------------
phase("Audit")

const ownerModel = quality.owner?.model && quality.owner.model !== "workflow role" ? quality.owner.model : null
const normalizeModel = (value) => value && !value.includes(":") ? value.replace("/", ":") : value
const auditorModel = normalizeModel(typeof args.auditor === "string" && args.auditor.trim() ? args.auditor.trim() : ownerModel)
if (quality.engine && quality.engine !== "native" && !auditorModel) return stopWith("blocked", "an auditor on engine " + quality.engine + " needs an exact model: pass auditor")

const auditRun = await agent(
  [
    "You are the auditor of work item " + item.id + ". You did not write it. Run whatever you need, including the repository's own verification even when it writes logs, evidence or temporary files under ignored paths (.mend/, /tmp). Do not edit tracked files and make no commit: the workflow blocks the audit if the head moves or a tracked or new unignored file appears.",
    "Worktree " + worktree + " (cd into it). Base " + baseSha + ", head " + head + ".",
    "Item: " + JSON.stringify({ goal: item.goal, acceptance: item.acceptance, editSet: item.editSet, checks: itemChecks }),
    "Rerun every item check yourself at head, independently rerun the complete owner's driven path, and read the full diff (git diff " + baseSha + " " + head + diffPaths + "). Compare the result with the goal and each acceptance line.",
    "Owner's account of what it drove and did not verify: " + JSON.stringify(quality.card ?? {}),
    "Return separate lanes named exactly checks and driven-path, with concrete methods and evidence for each. If the driven path is missing, incomplete or cannot be rerun, mark it MISSING or BLOCKED, never PASS.",
    "Report PASS only if every acceptance line is met at this head and every check you ran exits 0. ISSUES names each problem with file:line. BLOCKED names what you could not run.",
    "Judge the change, not your own tooling: a driver or script of yours that fails because of itself is not a problem of the change; repair it or drive the path another way. An item check that exits non-zero is always ISSUES.",
    "When an acceptance line is visual, look at it: render it to a PNG under " + evidenceDir + "/screens/ (the browser tool's screenshot on the local dev server when you have that tool, or a screenshot or render script the repository already has), open the PNG with the read tool, which shows you the image, take two or more shots apart in time for motion, and name each screenshot path in the driven-path lane. A look you still could not see goes in notVerified for the human, never by itself ISSUES or BLOCKED.",
  ].join("\n"),
  {
    label: "audit " + item.id,
    phase: "Audit",
    // The host's read mode has no shell, and the auditor must rerun the checks; checkoutProblem() after
    // the audit is what keeps it read-only.
    mode: "work",
    detail: true,
    ...(auditorModel ? { model: auditorModel } : {}),
    ...(quality.engine && quality.engine !== "native" ? { engine: quality.engine } : {}),
    schema: {
      type: "object",
      required: ["result", "lanes", "notVerified"],
      properties: {
        result: { type: "string", enum: ["PASS", "ISSUES", "BLOCKED"] },
        lanes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["lane", "result", "method"],
            properties: { lane: { type: "string" }, result: { type: "string", enum: ["PASS", "ISSUES", "BLOCKED", "MISSING"] }, method: { type: "string" } },
          },
        },
        notVerified: { type: "array", items: { type: "string" } },
        attention: { type: "array", items: { type: "string" } },
      },
    },
  },
).catch((error) => {
  // An auditor that ends blocked is a result to report, not a crash of the run.
  if (!/\) failed: blocked:/.test(String(error?.message))) throw error
  return { stopped: String(error.message).replace(/^.*?failed: blocked:\s*/s, "").slice(0, 600) }
})
if (auditRun?.stopped) return stopWith("blocked", "the auditor stopped before a verdict: " + auditRun.stopped)
// With detail, the host returns the schema-validated object as value and the agent's prose as text.
const audit = auditRun?.value && typeof auditRun.value === "object" ? auditRun.value : jsonOutput(auditRun?.text)
const ownerSession = typeof quality.owner?.session === "string" ? quality.owner.session.trim() : ""
const auditorSession = typeof auditRun?.taskId === "string" ? auditRun.taskId.trim() : ""
if (!audit || !Array.isArray(audit.lanes) || !Array.isArray(audit.notVerified)) return stopWith("blocked", "the auditor returned an invalid structured report")
if (!ownerSession || !auditorSession || ownerSession === auditorSession) return stopWith("blocked", "distinct owner and auditor session identifiers are required")
const afterAuditProblem = await checkoutProblem()
if (afterAuditProblem) return stopWith("blocked", afterAuditProblem)

// ---------------------------------------------------------------------------
phase("Card")

const auditRejected = audit.result === "ISSUES" || audit.lanes.some((lane) => lane.result === "ISSUES")
if (auditRejected) {
  roundState.rejectedBy.push("auditor")
  roundState.feedback = "The auditor reported issues at " + head + ": " + JSON.stringify({ result: audit.result, lanes: audit.lanes, attention: audit.attention ?? [] })
  await writeText(stateFile, JSON.stringify(roundState, null, 2))
}
const grant = authorization.json.grant
const tier = authorization.json.tier
const rung = blockingFlags.length === 0 && countersigned.length === 0 ? authorization.json.rung : lower(RUNG_ORDER, authorization.json.rung, "draft")
const ownerCard = quality.card ?? {}
const listOrNone = (value) => (Array.isArray(value) && value.length > 0 ? value.map(String) : ["none"])
// Model catalog IDs do not establish a provider family. Preserve comments without claiming cross-family review.
const auditAttention = Array.isArray(audit.attention) ? audit.attention.map(String) : []
const notVerified = [...new Set([...(Array.isArray(ownerCard.notVerified) ? ownerCard.notVerified : []), ...audit.notVerified, ...auditAttention.map((flag) => "Auditor attention (cross-family review unverified): " + flag)].map(String))]
const decisionLog = evidenceDir + "/decisions.tsv"

const exists = await run(host("exists", { cwd: worktree, file: decisionLog }))
if (!exists.ok) await writeText(worktree + "/" + decisionLog, "ts\tphase\tdecision\twhy\tevidence\tresult\n")
await appendText(
  worktree + "/" + decisionLog,
  [new Date().toISOString(), "audit", "verdict " + audit.result, "auditor " + auditorSession + " at head " + head, "mend-pr audit lanes", audit.result].join("\t") + "\n",
)

const profiles = quality.plan.profiles.map((profile) => {
  const rubricEntry = quality.checkResults?.rubric?.profiles?.find((entry) => entry.kind === profile.kind)
  const entry = { kind: profile.kind, skipped: rubricEntry?.skipped === true }
  if (entry.skipped) entry.skipReason = rubricEntry.skipReason
  entry.rubric = rubricEntry?.rubric ?? { pass: false, failures: [{ target: profile.kind, rule: "no-result", detail: "no rubric result from mend-quality" }] }
  const score = quality.critiqueScores?.[profile.kind]
  entry.critique = { model: quality.critic, score: typeof score === "number" ? score : 0, notes: typeof score === "number" ? "lowest head of the last counted round" : "no category of this profile was scored" }
  const exceptions = [...(rubricEntry?.checks ?? []), ...(rubricEntry?.integrationCheck ? [rubricEntry.integrationCheck] : [])]
    .filter((check) => check.overrides?.length || check.allowed?.length)
    .map((check) => ({ check: check.id, overrides: check.overrides ?? [], allowed: check.allowed ?? [] }))
  if (exceptions.length) entry.critique.notes += "; recorded exceptions: " + JSON.stringify(exceptions)
  if (rubricEntry?.integrationDiff) entry.integrationDiff = rubricEntry.integrationDiff
  const evidence = quality.profileEvidence?.[profile.kind] ?? {}
  for (const field of profile.cardFields ?? []) {
    if (["kind", "skipped", "skipReason", "rubric", "critique", "integrationDiff"].includes(field)) continue
    if (field === "approvedProposal" && !quality.approvedProposals?.includes(evidence[field])) continue
    if (Object.hasOwn(evidence, field)) entry[field] = evidence[field]
  }
  return entry
})

const cardPath = worktree + "/.mend/evidence/" + item.id + ".json"
const card = {
  schemaVersion: "1",
  item: item.id,
  problem: String(ownerCard.problem ?? item.problem ?? item.goal),
  goal: String(item.goal),
  state: "draft",
  rung,
  grant,
  risk: { tier, rule: String(authorization.json.riskRule ?? ownerCard.riskRule ?? item.riskRule ?? "the item's declared risk and its profiles' risk floors") },
  owner: { model: String(ownerModel ?? "workflow role"), ...(quality.owner?.session ? { session: String(quality.owner.session) } : {}) },
  branch: quality.branch,
  baseSha,
  headSha: head,
  checks,
  drivenPath: { steps: (ownerCard.drivenPath?.steps ?? []).map(String), artifacts: (ownerCard.drivenPath?.artifacts ?? []).map(String) },
  proof: ownerCard.proof && typeof ownerCard.proof.changeType === "string" ? ownerCard.proof : { changeType: "other", note: "the owner recorded no proof" },
  profiles,
  ...(quality.proposalApproval ? { proposalApproval: (({ approver, by, at, reason, artifacts }) => ({ approver, by, at, reason, artifacts }))(quality.proposalApproval) } : {}),
  critique: quality.critique,
  integrity: { pass: blockingFlags.length === 0, flags, countersigned },
  ...(redGreen ? { redGreen } : {}),
  rounds: { used: roundState.rejectedBy.length, budget: quality.rounds.budget, rejectedBy: roundState.rejectedBy },
  verdict: { result: audit.result, sha: head, patchId, author: ownerSession, verifier: auditorSession, verifierModel: String(auditorModel ?? "workflow role") },
  auditLanes: audit.lanes.map((lane) => ({ lane: lane.lane, result: lane.result, sha: head, method: lane.method })),
  decisionLog,
  notVerified: notVerified.length > 0 ? notVerified : ["nothing recorded; treat every path the checks did not drive as unverified"],
  notChanged: listOrNone(ownerCard.notChanged),
  uncertain: listOrNone(ownerCard.uncertain),
  rollback: String(ownerCard.rollback ?? "revert the merge commit"),
  countersigns,
  flaky: [],
}

// Workflow scripts cannot load modules: the secret scan and the schema run in card-check.mjs.
async function cardCheck() {
  await writeText(cardPath, JSON.stringify(card, null, 2))
  const result = await run(tool("card-check.mjs", [cardPath, worktree, baseSha]))
  return result.ok && Array.isArray(result.json?.failures) ? result.json : { secret: null, failures: [{ kind: "generic", target: "(card)", rule: "card-schema", detail: "schema validation failed: " + result.detail.slice(-300) }] }
}
const cardSecret = (await cardCheck()).secret
if (cardSecret) {
  const flag = { rule: "secret-like", file: "(card)", line: 0, detail: cardSecret + " in composed evidence card; value withheld", severity: "block" }
  flags.push(flag)
  card.integrity.pass = false
  card.rung = lower(RUNG_ORDER, card.rung, "draft")
}

const allChecksPass = checks.every((entry) => entry.exit === 0)
const requiredLanes = ["checks", "driven-path"]
const pathSteps = ownerCard.drivenPath?.steps
const auditPass = audit.result === "PASS" && Array.isArray(pathSteps) && pathSteps.length > 0 && pathSteps.every((step) => typeof step === "string" && step.trim()) && requiredLanes.every((name) => audit.lanes.some((lane) => lane.lane === name && lane.result === "PASS" && typeof lane.method === "string" && lane.method.trim())) && audit.lanes.every((lane) => lane.result === "PASS")
const candidate = allChecksPass && auditPass && card.integrity.pass ? (grant.queue && tier === "low" && ["autopilot", "full"].includes(rung) ? "ready" : "merge-ready") : "draft"
card.state = candidate
const schemaFailures = (await cardCheck()).failures.map((failure) => ({ kind: "generic", ...failure }))
if (schemaFailures.length) card.state = "draft"
await writeText(cardPath, JSON.stringify(card, null, 2))

const final = await run(tool("run-rubric.mjs", ["run", "--item", itemPath, "--base", baseSha, "--head", head, "--repo", worktree, "--integration"]))
const lateApprovalFailure = await verifyApproval()
if (lateApprovalFailure) {
  card.state = "draft"
  await writeText(cardPath, JSON.stringify(card, null, 2))
  return stopWith("draft", lateApprovalFailure, { card: cardPath })
}
const cardFailures = [...schemaFailures, ...(final.json ? final.json.profiles.flatMap((entry) => entry.rubric.failures.map((failure) => ({ kind: entry.kind, ...failure }))) : [{ rule: "no-report", detail: final.detail.slice(-300) }])]
if (card.state !== "draft" && (schemaFailures.length || !final.json || !final.json.pass)) {
  card.state = "draft"
  await writeText(cardPath, JSON.stringify(card, null, 2))
}

const reasons = []
if (!allChecksPass) reasons.push("a contract check exited non-zero")
if (!auditPass) reasons.push("the auditor reported " + audit.result)
if (!card.integrity.pass) reasons.push("integrity flags are not countersigned")
if (schemaFailures.length) reasons.push("card schema validation failed")
if (final.json && !final.json.pass) reasons.push("card checks failed")
return { state: card.state, card: cardPath, verdict: card.verdict, reasons, cardFailures, branch: quality.branch, worktree }
