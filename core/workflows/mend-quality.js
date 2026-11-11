export const meta = {
  name: "mend-quality",
  description: "One work item: strong-model spec, proposal, cheap-owner rounds, rubric, integrity, strong critique, approval",
  phases: [
    { title: "Plan", detail: "profiles, worktree, planner spec, restatement" },
    { title: "Proposal", detail: "only for profiles that declare one" },
    { title: "Rounds", detail: "owner, rubric, integrity, critique" },
    { title: "Approval", detail: "only for profiles that ask a human" },
  ],
  budget: { agents: 24, minutes: 240 },
  permission: "edits",
  maxConcurrent: 1,
}

const DEFAULT_THRESHOLD = 7
const DEFAULT_DRIFT = 1
const js = JSON.stringify
const ANCHORS = "exemplar anchors changed between rounds; restart with the intended references"
const STR = { type: "string" }, BOOL = { type: "boolean" }
const shape = (properties) => ({ type: "object", required: Object.keys(properties), properties })
const BLOCKING = ["blocker", "should"]
const trimmed = (value) => typeof value === "string" ? value.trim() : ""

function required(name) {
  const value = args[name]
  if (!trimmed(value)) throw new Error("[MEND-QUALITY]: argument " + name + " is required")
  return value.trim()
}

const repo = trimmed(args.repo)
if (!repo) return blockWith("argument repo is required: the repository's absolute path")
if (!repo.startsWith("/")) return blockWith("argument repo must be an absolute path")
const repoPath = (value) => value.startsWith("/") ? value : repo + "/" + value
const pkg = repoPath(required("pkg"))
const itemPath = repoPath(required("item"))
const normalizeModel = (value) => value && !value.includes(":") ? value.replace("/", ":") : value
const critic = normalizeModel(required("critic"))
const engine = trimmed(args.engine) || null
const workerModel = normalizeModel(trimmed(args.model)) || null
if (engine && engine.startsWith("acp")) throw new Error("[MEND-QUALITY]: workflows do not accept ACP")
if (engine && engine !== "native" && !workerModel) throw new Error("[MEND-QUALITY]: argument model is required with engine " + engine)
const threshold = Number(args.threshold ?? DEFAULT_THRESHOLD)
if (!Number.isFinite(threshold) || threshold < DEFAULT_THRESHOLD || threshold > 10) throw new Error("[MEND-QUALITY]: threshold must be between 7 and 10")

function placed(options, model) {
  const chosen = model ?? workerModel
  return Object.assign({}, options, chosen ? { model: chosen } : {}, engine ? { engine } : {})
}
const driftTolerance = Number(args.driftTolerance ?? DEFAULT_DRIFT)

const quote = (value) => "'" + String(value).split("'").join("'\"'\"'") + "'"
const shellArgs = (values) => values.map(quote).join(" ")
let policyBinding = null
const tool = (script, rest, text) => ({ command: "node " + quote(pkg + "/checks/" + script) + " --stdin", stdin: js({ args: rest, policy: policyBinding, text }) })
const host = (operation, data) => tool("workflow-host.mjs", [operation, js(data)])
const git = (values, cwd) => host("git", { args: values, cwd })

function lastJsonLine(text) {
  for (const line of String(text ?? "").trim().split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue
    try { return JSON.parse(line.trim()) } catch { return null }
  }
  return null
}

function ownerReport(text) {
  let match, last = null
  const heading = /^#{1,6}[ \t]+owner report[ \t]*\r?\n([^\r\n]*)/gim
  while ((match = heading.exec(String(text ?? "")))) {
    try {
      const value = JSON.parse(match[1].trim())
      last = value && typeof value === "object" && !Array.isArray(value) ? value : null
    } catch { last = null }
  }
  return last
}

function jsonOutput(text) {
  const source = String(text ?? "")
  const start = source.search(/^\{/m)
  const end = source.lastIndexOf("}")
  for (const candidate of [source.trim(), start >= 0 && end > start ? source.slice(start, end + 1) : ""]) {
    if (!candidate) continue
    try { return JSON.parse(candidate) } catch {}
  }
  return lastJsonLine(source)
}

async function run({ command, stdin }) {
  if (command.length > 300 || /[;&|<>`$\\\n\r]/.test(command)) throw new Error("package path cannot be represented by check()")
  const result = await check(command, { stdin })
  if (result.truncated) throw new Error("[MEND-QUALITY]: output of a host command was truncated by the runtime: " + command.slice(0, 120))
  const detail = String(result.detail ?? "").replace(/^exit -?\d+\n?/, "")
  return { ok: result.ok, detail, json: jsonOutput(detail) }
}

async function writeText(file, text, exclusive = null) {
  const result = await run(tool("write-file.mjs", [file, ...(exclusive === null ? [] : ["--exclusive"])], text))
  if (!result.ok) throw new Error("[MEND-QUALITY]: " + (exclusive === null
    ? "could not write " + file + ": " + result.detail.slice(-300)
    : "critique log already exists or cannot be written: " + exclusive))
}

const writeJson = (file, value) => writeText(file, js(value, null, 2))

async function readJson(file) {
  const result = await run(host("read-json", { file }))
  return result.ok ? result.json : null
}

function globRegExp(glob) {
  let source = ""
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === "*" && glob[i + 1] === "*") {
      source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"
      i += glob[i + 2] === "/" ? 2 : 1
    } else if (char === "*") source += "[^/]*"
    else if (char === "?") source += "[^/]"
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp("^" + source + "$")
}

function blockWith(reason, extra) { return stopWith("blocked", reason, extra) }
function blockHere(reason, extra) { return stopHere("blocked", reason, extra) }
function stopWith(state, reason, extra) {
  log("stop", state, reason)
  return Object.assign({ state, reason }, extra ?? {})
}

phase("Plan")

const top = await run(git(["rev-parse", "--show-toplevel"], repo))
const repoRoot = top.detail.trim().split("\n").pop()
if (!top.ok || !repoRoot.startsWith("/")) return blockWith("could not resolve the repository root from argument repo: " + top.detail.slice(-300))
const item = await readJson(itemPath)
if (!item || typeof item.id !== "string") return blockWith("the item file " + itemPath + " is missing or has no id")
const originalItem = JSON.parse(js(item))
const planned = await run(tool("run-rubric.mjs", ["plan", "--item", itemPath]))
if (!planned.ok || !planned.json) return blockWith("run-rubric plan failed: " + planned.detail.slice(-400))
const plan = planned.json
const redProposal = plan.profiles.some((profile) => profile.proposalArtifact?.name === "reproduction")
if (redProposal && ![item.regressionCommand, item.regression].some((command) => trimmed(command))) return blockWith("a reproduction proposal needs a regression command on the item")
const editSet = Array.isArray(item.editSet) ? item.editSet.map(String) : []
if (editSet.length === 0) return blockWith("the item has no editSet; the lead writes one before dispatch")

const preflight = await run(tool("dispatch.mjs", ["preflight", "--repo", repoRoot, "--item", itemPath]))
if (!preflight.ok || preflight.json?.pass !== true) return blockWith(preflight.json?.reason ?? "dispatch preflight failed")
item.rung = preflight.json.rung

if (plan.suggested.length > 0) {
  const answer = await ask(
    "Item " + item.id + " does not declare profiles that its edit set or goal suggest: " + plan.suggested.join(", ") + ". Continue with the declared profiles only?",
    ["continue as declared", "stop so the lead can add them"],
  )
  if (answer !== "continue as declared") return stopWith("draft", "the lead is reviewing the suggested profiles " + plan.suggested.join(", "))
}

const ignored = await run(git(["check-ignore", "-q", ".mend/worktrees/probe"], repoRoot))
if (!ignored.ok) return blockWith("add .mend/ to .gitignore before dispatch; evidence and worktrees live there")
const worktree = repoRoot + "/.mend/worktrees/" + item.id
const branch = "mend/" + item.id
const stopHere = (state, reason, extra) => stopWith(state, reason, { worktree, branch, ...extra })
const runInWorktree = (values) => run(git(values, worktree))
function budgetSpent(ledger, rejectedBy) {
  return stopHere("draft", "round budget spent", {
    baseSha, critique: ledger, rejectedBy,
    escalation: { proposed: true, toModel: "a strong owner", reason: "rejected " + rejectedBy.length + " rounds: " + rejectedBy.join(", ") },
  })
}
const baseLine = await run(git(["rev-parse", "HEAD"], repoRoot))
let baseSha = baseLine.detail.trim().split("\n").pop()
if (!/^[0-9a-f]{40}$/.test(baseSha)) return blockWith("could not read the base commit")
const pathPreflight = await run(host("worktree-preflight", { cwd: repoRoot }))
if (!pathPreflight.ok) return blockWith("unsafe worktree setup: " + pathPreflight.detail.slice(-300))
const exists = await run(host("exists", { file: worktree, directory: true }))
if (!exists.ok) {
  const added = await run(git(["worktree", "add", "-b", branch, worktree, baseSha], repoRoot))
  if (!added.ok) return blockWith("git worktree add failed: " + added.detail.slice(-300))
}
const setup = await run(tool("dispatch.mjs", ["propagate", "--repo", repoRoot, "--item", itemPath]))
if (!setup.ok || setup.json?.pass !== true) return blockWith(setup.json?.reason ?? "worktree setup failed")
const evidenceDir = ".mend/evidence/" + item.id
const evidencePath = (name) => worktree + "/" + evidenceDir + "/" + name
const stateFile = evidencePath("round-state.json")
const stateExists = await run(host("exists", { file: stateFile }))
const saved = stateExists.ok ? await readJson(stateFile) : null
const proposalTestGlobs = saved?.proposalTestGlobs ?? (await readJson(repoRoot + "/.mend/integrity.json"))?.testGlobs ?? []
if (stateExists.ok && (!saved || saved.item !== item.id || !/^[0-9a-f]{40}$/.test(saved.baseSha) || !Array.isArray(saved.rejectedBy) || !["rounds", "findings", "critics"].every((k) => Array.isArray(saved.ledger?.[k])) || !Number.isInteger(saved.critiqueRound) || saved.critiqueRound < 0)) {
  return blockHere("the saved round state is invalid; recover its evidence before restarting")
}
if (saved) {
  if (saved.ledger.threshold !== threshold || saved.ledger.driftTolerance !== driftTolerance || !saved.ledger.critics.includes(critic)) return blockHere("the saved critique settings differ; recover the item first")
  baseSha = saved.baseSha
  if (saved.rejectedBy.length >= plan.roundBudget) return budgetSpent(saved.ledger, saved.rejectedBy)
}
const lenses = plan.profiles.map((profile) => profile.critiqueLens)
const approvalPath = repoRoot + "/.mend/approvals/" + item.id + ".json"
let proposalApproval = saved?.proposalApproval ?? null
let resultApproval = null

async function approvalInputs(mode, inputs) {
  const result = await run(tool("approval.mjs", [mode, worktree, js(inputs)]))
  return result.ok && result.json?.pass ? result.json : { pass: false, error: result.json?.error ?? "approval input check failed" }
}

async function verifyInputs(inputs) {
  const result = await approvalInputs("verify", inputs)
  return result.pass ? null : stopHere("draft", result.error)
}

function validCritiqueIdentities(identities, rounds) {
  return Array.isArray(identities) && rounds.every((round) =>
    identities.some((input) => input.path === round.log && /^[a-f0-9]{64}$/.test(input.sha256 ?? "")))
}
const missingIdentities = "saved critique identities are invalid; recover the evidence"

if (saved?.ledger.rounds.length) {
  const identities = saved.critiqueIdentities
  if (!validCritiqueIdentities(identities, saved.ledger.rounds)) return blockHere(missingIdentities)
  const problem = await verifyInputs(identities)
  if (problem) return problem
}

async function itemUnchanged() {
  const current = await readJson(itemPath)
  return current && js(current) === js(originalItem)
}
async function approvedItemProblem(inputs) {
  if (inputs) {
    const problem = await verifyInputs(inputs)
    if (problem) return problem
  }
  return await itemUnchanged() ? null : stopHere("draft", "approved item changed; reapproval required")
}
const qualityConfig = await readJson(repoRoot + "/.mend/quality.json") ?? {}
const growthFactor = Number(qualityConfig.critique?.growthFactor ?? 2)
if (!Number.isFinite(growthFactor) || growthFactor <= 1) return blockWith("critique.growthFactor must be greater than 1")
if (saved && !saved.reviewPolicy) return blockWith("the saved review policy is missing; recover trusted configuration first")
policyBinding = saved?.reviewPolicy ?? null
const reviewPolicy = await run(tool("review-policy.mjs", [worktree, baseSha]))
if (!reviewPolicy.ok || !Array.isArray(reviewPolicy.json?.pathspec)) return blockWith("could not load the review exclusions: " + reviewPolicy.detail)
policyBinding = reviewPolicy.json
await writeJson(stateFile, saved ?? { item: item.id, baseSha, reviewPolicy: policyBinding, proposalTestGlobs, ledger: { threshold, driftTolerance, critics: [critic], rounds: [], findings: [] }, rejectedBy: [], critiqueRound: 0 })
const diffPaths = " -- " + shellArgs(reviewPolicy.json.pathspec)
async function policyProblem() {
  const result = await run(tool("review-policy.mjs", [worktree, baseSha]))
  return result.ok ? null : "review policy changed after capture; recover trusted configuration before continuing"
}
const verification = await readJson(repoRoot + "/.mend/evidence/verify.json")
if (!Array.isArray(verification?.steps) || !verification.steps.length || verification.steps.some((s) => typeof s?.command !== "string" || !s.command.trim() || s.exit !== 0)) return blockWith("the verification record must list every passing verification command")
const verificationCommands = [...new Set(verification.steps.map((step) => step.command))]

async function promptFor(kind, data) {
  const result = await run(tool("quality-prompts.mjs", [kind, js(data)]))
  const prompt = result.json?.prompt
  const valid = kind === "context"
    ? prompt && ["context", "ownerReport", "restate", "proposal", "planEvidence"].every((key) => typeof prompt[key] === "string")
    : typeof prompt === "string"
  if (!result.ok || !valid) throw new Error("[MEND-QUALITY]: prompt construction failed: " + kind)
  return prompt
}
const planner = normalizeModel(trimmed(args.planner)) || critic
const pData = { pkg, item, plan, worktree, branch, evidenceDir, verificationCommands }
const specPath = evidenceDir + "/spec.md"
const kept = saved && trimmed((await readJson(evidencePath("spec.json")))?.spec)
const spec = kept || trimmed((await agent(await promptFor("spec", pData), placed({ label: "spec " + item.id, phase: "Plan", mode: "read", schema: shape({ spec: STR }) }, planner)))?.spec)
if (!spec) return blockWith("the planner returned no spec")
if (!kept) await writeJson(evidencePath("spec.json"), { planner, spec })
await writeText(worktree + "/" + specPath, spec + "\n")
const prompts = await promptFor("context", { ...pData, specPath })
const context = prompts.context

const restatement = await agent(
  prompts.restate,
  placed({ label: "restate " + item.id, phase: "Plan", mode: "read", schema: shape({ goal: STR, finish: STR, files: { type: "array", items: STR } }) }),
)
const outside = restatement.files.filter((file) => !editSet.some((glob) => globRegExp(glob).test(file)))
if (outside.length > 0) return stopWith("draft", "the owner expects to touch files outside the edit set: " + outside.join(", "), { restatement })
if (typeof plan.fileCap === "number" && restatement.files.length > plan.fileCap) {
  return stopWith("draft", "the owner expects " + restatement.files.length + " files, above the file cap " + plan.fileCap + "; split the item", { restatement })
}

async function owner(task, label) {
  // A blocked owner spends its round
  let result
  try { result = await agent(context + "\n\n" + task + "\n\n" + prompts.ownerReport, placed({ label, phase: "Rounds", mode: "work", detail: true })) } catch (e) { if (!/\) failed: blocked:/.test(e?.message)) throw e; result = { text: "", stopped: String(e?.message ?? e).slice(-600) } }
  const report = ownerReport(result.text) ?? { stopped: result.stopped }
  const headLine = await runInWorktree(["rev-parse", "HEAD"])
  report.head = headLine.detail.trim().split("\n").pop()
  report.session = result.taskId
  return report
}

phase("Proposal")

const withProposal = plan.profiles.filter((profile) => profile.proposalArtifact)
let approvedProposals = saved?.approvedProposals ?? []
let proposalEvidence = saved?.proposalEvidence ?? {}
let lastReport = null
if (saved?.phase === "integration" && (!proposalApproval || !Array.isArray(proposalApproval.inputs) || !proposalApproval.inputs.length || !Array.isArray(approvedProposals))) return blockHere("saved proposal approval is invalid; recover the original evidence")
if (saved?.phase === "integration") {
  const problem = await approvedItemProblem(proposalApproval.inputs)
  if (problem) return problem
} else if (withProposal.length > 0) {
  lastReport = await owner(prompts.proposal, "proposal " + item.id)
  const problem = await policyProblem()
  if (problem) return blockHere(problem)
  approvedProposals = Array.isArray(lastReport.proposals) ? lastReport.proposals : []
  if (approvedProposals.length === 0) return blockHere("the owner reported no proposal artifacts")
  proposalEvidence = lastReport.profileEvidence ?? {}
  for (const profile of withProposal) {
    const evidence = proposalEvidence[profile.kind], own = approvedProposals.filter((f) => f.includes("/" + profile.proposalArtifact.name + "."))
    if (evidence && !evidence.approvedProposal && !own[1]) evidence.approvedProposal = own[0]
    if (!evidence || !approvedProposals.includes(evidence.approvedProposal)) return blockHere("the owner did not identify an approved proposal for " + profile.kind)
  }
}
const proposalApprover = plan.profiles.some((profile) => profile.proposalApprover === "human") ? "human" : "supervisor"
const snapshotPath = evidenceDir + "/proposal-plan.json"
if (saved?.phase !== "integration") await writeJson(worktree + "/" + snapshotPath, { item: originalItem, restatement, spec: specPath })
const planSnapshot = saved?.phase === "integration" ? { pass: true, inputs: proposalApproval.inputs } : await approvalInputs("snapshot", [{ path: snapshotPath }, { path: specPath }])
if (!planSnapshot.pass) return blockHere(planSnapshot.error)
async function supervise(exemplars, noArtifacts = false) {
  return agent(
    await promptFor("supervise", { context, restatement, approvedProposals, exemplars, noArtifacts }),
    placed({ label: "supervise " + item.id, phase: "Proposal", mode: "read", schema: shape({ approved: BOOL, reason: STR, restatementMatches: BOOL }) }, critic),
  )
}
if (saved?.phase !== "integration" && !withProposal.length && proposalApprover === "supervisor") {
  const decision = await supervise(lastReport?.exemplars ?? [], true)
  if (decision?.approved !== true || !trimmed(decision.reason)) {
    return stopHere("draft", "the supervisor did not approve the proposal: " + (decision?.reason ?? "no valid decision"))
  }
  if (decision.restatementMatches !== true) return stopHere("draft", "the supervisor did not confirm the restatement against the item", { restatement })
  const problem = await approvedItemProblem(planSnapshot.inputs)
  if (problem) return problem
  proposalApproval = { approver: "supervisor", by: critic, at: new Date().toISOString(), reason: decision.reason.trim(), artifacts: [], inputs: planSnapshot.inputs }
  await writeJson(evidencePath("proposal-approval.json"), proposalApproval)
} else if (saved?.phase !== "integration" && !withProposal.length) {
  lastReport = await owner(prompts.planEvidence, "proposal " + item.id)
}

phase("Rounds")

const ledger = saved?.ledger ?? { threshold, driftTolerance, critics: [critic], rounds: [], findings: [] }
const rejectedBy = saved?.rejectedBy ?? []
const countersigns = (Array.isArray(saved?.countersigns) ? saved.countersigns : []).filter((sign) =>
  sign && typeof sign.kind === "string" && trimmed(sign.subject) && trimmed(sign.by) && trimmed(sign.reason) &&
  sign.reason.trim().toLowerCase() !== "no" && typeof sign.at === "string" && Number.isFinite(Date.parse(sign.at)),
)
function countersign(kind, subject, reason, at = new Date().toISOString()) {
  countersigns.push({ kind, subject, by: "operator", reason, at })
}
const flagsSentBack = new Set(saved?.flagsSentBack ?? [])
let feedback = saved?.feedback ?? null
let critiqueRound = saved?.critiqueRound ?? 0
let firstScores = saved?.firstScores ?? null
let previousHead = saved?.previousHead ?? baseSha
let voidStreak = saved?.voidStreak ?? 0
let exemplarIdentity = saved?.exemplarIdentity ?? null
const critiqueIdentities = saved?.critiqueIdentities ?? []
if (!validCritiqueIdentities(critiqueIdentities, ledger.rounds)) return blockHere(missingIdentities)

async function saveState() {
  await writeJson(stateFile, { item: item.id, baseSha, reviewPolicy: policyBinding, proposalTestGlobs, phase: proposalStage ? "proposal" : "integration", proposalApproval, approvedProposals, proposalEvidence, ledger, rejectedBy, countersigns, flagsSentBack: [...flagsSentBack], feedback, critiqueRound, firstScores, previousHead, voidStreak, exemplarIdentity, critiqueIdentities })
}

async function sendBack(by, reason) {
  rejectedBy.push(by)
  feedback = reason
  await saveState()
}

const openFindings = () => ledger.findings.filter((f) => f.status === "open" || f.status === "disputed")

function nextFindingId() {
  const ids = ledger.findings.map((f) => Number(f.id.slice(1)))
  return "F" + (ids.length === 0 ? 1 : Math.max(...ids) + 1)
}

function growthEvidence({ hunks, before, after, growthFactor, previousHead, head, findings, rounds }) {
  if (!Array.isArray(hunks) || hunks.some((hunk) => typeof hunk !== "string")) throw new Error("growth requires extracted hunk keys")
  return { before, after, growthFactor, previousHead, head, hunks, findings, logs: rounds.filter((r) => findings.some((f) => f.round === r.round)).map((r) => r.log) }
}

function justifiedGrowth({ growth, explanations }) {
  return growth.hunks.length > 0 && Array.isArray(explanations) && growth.hunks.every((h) => explanations.some((e) => e?.hunk === h && growth.findings.some((f) => f.id === e.finding) && typeof e.reason === "string" && e.reason.trim()))
}

async function reviewCalculation(kind, data) {
  const checked = await run(tool("quality-review.mjs", [kind, js(data)]))
  const result = checked.json?.result
  const valid = kind === "final" ? result && typeof result.critiqueScores === "object" && typeof result.profileEvidence === "object"
    : ["drift", "exemplars"].includes(kind) ? result === null || typeof result === "string"
    : Array.isArray(result) && result.every((entry) => kind === "inputs"
      ? entry && typeof entry.path === "string" : typeof entry === "string")
  if (!checked.ok || !valid) throw new Error("[MEND-QUALITY]: review calculation failed: " + kind)
  return result
}

async function critique(head, ownerReport, growth = null) {
  const exemplars = ownerReport.exemplars?.length ? ownerReport.exemplars : lastReport?.exemplars ?? []
  const error = await reviewCalculation("exemplars", { exemplars, profiles: plan.profiles, editSet })
  if (error) return { parsed: { error }, owner: 1 }
  const identities = await approvalInputs("snapshot", exemplars.map((entry) => ({ path: entry.path })))
  if (!identities.pass) return { parsed: { error: identities.error }, owner: 1 }
  const identity = js(exemplars.map((entry, index) => ({ label: entry.label, ...identities.inputs[index] })))
  if (exemplarIdentity !== null && identity !== exemplarIdentity) return { parsed: { error: ANCHORS } }
  exemplarIdentity = identity
  const expected = { categories: plan.critiqueCategories, anchors: exemplars.map((entry) => entry.label) }
  critiqueRound += 1
  const log = evidenceDir + "/critique-r" + critiqueRound + ".md"
  const stat = await runInWorktree(["diff", "--shortstat", baseSha, head, "--", ...reviewPolicy.json.pathspec])
  let prompt = await promptFor("critique", {
    pkg, lenses, worktree, baseSha, head, diffPaths, previousHead, evidenceDir,
    item: { id: item.id, goal: item.goal, acceptance: item.acceptance, editSet, quantity: item.quantity, profiles: plan.profiles.map((profile) => profile.kind) },
    stat: stat.detail, open: openFindings(), report: ownerReport, expected,
    snapshotPath, approvedProposals, approved: !!proposalApproval, nextFinding: nextFindingId(), hasGrowth: !!growth,
  })
  if (growth) prompt += "\nGrowth evidence: " + js(growth)
  const reply = await agent(prompt, placed({ label: "critique " + item.id, phase: "Rounds", mode: "read" }, critic))
  await writeText(worktree + "/" + log, reply, log)
  const logIdentity = await approvalInputs("snapshot", [{ path: log }])
  if (!logIdentity.pass) return { log, parsed: { error: logIdentity.error } }
  critiqueIdentities.push(...logIdentity.inputs)
  await saveState()
  const unchanged = await approvalInputs("verify", identities.inputs)
  if (!unchanged.pass) return { log, parsed: { error: unchanged.error } }
  const parsedRun = await run(tool("critic-reply.mjs", [worktree + "/" + log, js(expected)]))
  let growthReview = null
  try { growthReview = JSON.parse(/^growth: (.+)$/m.exec(String(reply))?.[1] ?? "null") } catch {}
  return { log, diffStat: stat.detail.trim().split("\n").pop() || "no changes", parsed: parsedRun.json, growthReview }
}

async function diffSize(head) {
  const result = await runInWorktree(["diff", "--numstat", baseSha, head, "--", ...reviewPolicy.json.pathspec])
  if (!result.ok) return null
  let size = 0
  for (const line of result.detail.trim().split("\n")) {
    if (!line) continue
    const match = /^(\d+|-)\s+(\d+|-)\s/.exec(line)
    if (!match) return null
    size += match[1] === "-" || match[2] === "-" ? 1 : Number(match[1]) + Number(match[2])
  }
  return size
}

let report = lastReport
let accepted = null
let proposalStage = proposalApproval === null
while (accepted === null) {
  if (rejectedBy.length >= plan.roundBudget) return budgetSpent(ledger, rejectedBy)
  if (!proposalStage || feedback !== null) {
    const task = await promptFor("owner", { proposalStage, feedback, approvedProposals, redProposal })
    report = await owner(task, "owner " + item.id + " r" + (rejectedBy.length + 1))
  }
  const ownerPolicyProblem = await policyProblem()
  if (ownerPolicyProblem) return blockHere(ownerPolicyProblem)
  if (proposalStage && redProposal) {
    const red = await run(tool("proposal-red.mjs", [js({ repo: worktree, base: baseSha, head: report.head, item, proposalTestGlobs })]))
    if (!red.ok || !red.json) return blockHere("reproduction proposal rejected: " + red.detail.slice(-600))
    const reproduction = evidenceDir + "/proposal/reproduction.json"
    await writeJson(worktree + "/" + reproduction, red.json)
    for (const p of withProposal.filter((e) => e.proposalArtifact.name === "reproduction")) {
      report.proposals = [...new Set([...(report.proposals ?? []), reproduction])]
      report.profileEvidence = { ...report.profileEvidence, [p.kind]: { ...report.profileEvidence?.[p.kind], approvedProposal: reproduction } }
    }
  }
  if (exemplarIdentity !== null) {
    const unchanged = await approvalInputs("verify", JSON.parse(exemplarIdentity))
    if (!unchanged.pass) return blockHere(ANCHORS)
  }
  const verificationFailures = []
  const verifiedCommands = []
  for (let index = 0; index < (proposalStage && redProposal ? 0 : verificationCommands.length); index += 1) {
    const command = verificationCommands[index]
    const guard = await run(host("guard", { cwd: worktree, command }))
    if (!guard.ok) return blockWith("the guard refuses a verification command: " + guard.detail)
    const name = "verify-r" + (rejectedBy.length + 1) + "-" + (index + 1)
    const logFile = evidenceDir + "/" + name + ".log"
    const checked = await run(host("execute", { cwd: worktree, command, file: logFile }))
    const captured = await run(host("read", { cwd: worktree, file: logFile }))
    const match = /(?:^|\n)exit: (\d+)\s*$/.exec(captured.detail)
    const exit = checked.ok && captured.ok && match ? Number(match[1]) : 1
    verifiedCommands.push({ name, command, exit, log: logFile })
    if (exit !== 0) verificationFailures.push({ command, exit, log: logFile, output: captured.detail })
  }
  report.commands = [...(report.commands ?? []), ...verifiedCommands]
  const verificationPolicyProblem = await policyProblem()
  if (verificationPolicyProblem) return blockHere(verificationPolicyProblem)
  const verifiedHead = await runInWorktree(["rev-parse", "HEAD"])
  const verifiedStatus = await runInWorktree(["status", "--porcelain", "--untracked-files=all", "--", ...reviewPolicy.json.pathspec])
  if (!verifiedHead.ok || verifiedHead.detail.trim().split("\n").pop() !== report.head || !verifiedStatus.ok || verifiedStatus.detail.trim()) return blockHere("verification changed the reviewed head or authored files:" + verifiedHead.detail.slice(-50) + verifiedStatus.detail.slice(0, 200))
  if (verificationFailures.length) {
    await sendBack("rubric", "Full verification failed. Fix the failure; do not narrow the verification:\n" + js(verificationFailures))
    continue
  }
  for (const subject of Array.isArray(report.card?.irreversible) ? report.card.irreversible : []) {
    if (!trimmed(subject) || countersigns.some((sign) => sign.kind === "irreversible" && sign.subject === subject)) continue
    const answer = await ask("Countersign irreversible step " + subject + "? Reply 'no' or provide a reason.")
    const reason = trimmed(answer)
    if (reason && reason.toLowerCase() !== "no") countersign("irreversible", subject, reason)
  }
  if (typeof plan.fileCap === "number") {
    const actual = await run(host("count", { cwd: worktree, base: baseSha, head: report.head, pathspec: reviewPolicy.json.pathspec }))
    if (!actual.ok || !Number.isInteger(actual.json?.count)) return blockHere("could not count the committed diff files")
    if (actual.json.count > plan.fileCap) {
      await sendBack("rubric", "The committed diff changes " + actual.json.count + " files, above the file cap " + plan.fileCap + "; reduce the scope.")
      continue
    }
  }
  if (proposalStage) approvedProposals = Array.isArray(report.proposals) ? report.proposals : []
  let proposalCandidate = null
  if (proposalStage) {
    const problem = await verifyInputs(planSnapshot.inputs)
    if (problem) return problem
    const inputs = await reviewCalculation("inputs", { withProposal, evidenceDir, approvedProposals, planInputs: planSnapshot.inputs })
    proposalCandidate = await approvalInputs("snapshot", inputs)
    if (!proposalCandidate.pass) return blockHere(proposalCandidate.error)
  }
  const approvalProblem = await approvedItemProblem(proposalApproval?.inputs)
  if (approvalProblem) return approvalProblem
  for (const dispute of report.disputes ?? []) {
    const finding = ledger.findings.find((entry) => entry.id === dispute.id)
    if (!finding) continue
    if (finding.status === "disputed") {
      const answer = await ask("The owner disputes " + finding.id + " again: " + dispute.reason + ". Who is right?", ["owner: decline the finding", "critic: keep it open"])
      if (answer.startsWith("owner")) Object.assign(finding, { status: "declined", reason: "decided by the human: " + dispute.reason })
      else finding.status = "open"
    } else if (finding.status === "open") Object.assign(finding, { status: "disputed", reason: dispute.reason })
  }

  const reviewCardPath = evidencePath("review-card.json")
  await writeJson(reviewCardPath, { ...(report.card ?? {}), state: "draft", countersigns })
  const reviewArgs = ["--base", baseSha, "--head", report.head, "--item", itemPath, "--repo", worktree]
  const rubric = await run(tool("run-rubric.mjs", ["run", ...reviewArgs, proposalStage ? "--proposal" : "--integration", "--review-card", reviewCardPath]))
  const integrity = await run(tool("integrity.mjs", [...reviewArgs, "--json"]))
  report.checkResults = { rubric: rubric.json, integrity: integrity.json }
  const integrityReport = integrity.json, IR = integrityReport, full = (v) => typeof v === "string" && v !== ""
  const validFlags = Array.isArray(IR?.flags) && IR.flags.every((f) => f && full(f.rule) && full(f.file) && Number.isInteger(f.line) && f.line >= 0 && typeof f.detail === "string" && (f.severity === "warn" || f.severity === "block"))
  if (!validFlags || typeof IR.pass !== "boolean" || IR.pass !== !IR.flags.some((f) => f.severity === "block") || integrity.ok !== IR.pass) return blockHere("the integrity scan failed or returned an invalid report: " + integrity.detail.slice(-400))
  if (!rubric.json) return blockHere("run-rubric did not report: " + rubric.detail.slice(-400))
  if (rubric.json.blocked) return blockHere("a rubric check is blocked", { rubric: rubric.json })
  if (!rubric.json.pass && rubric.json.checksPass && rubric.json.loosenings?.length) {
    const subject = js(rubric.json.loosenings)
    const reply = await ask("Gate loosenings on " + item.id + ": " + subject + "\nReply 'no' to send back, or give a reason to countersign these exact settings.")
    const answer = trimmed(reply)
    if (answer && answer.toLowerCase() !== "no") {
      const at = new Date().toISOString()
      countersign("gate-loosening", subject, answer, at)
      for (const entry of rubric.json.profiles) for (const check of [...entry.checks, ...(entry.integrationCheck ? [entry.integrationCheck] : [])]) for (const override of check.overrides ?? []) if (override.loosens && typeof check.id === "string" && check.id) countersign("gate-loosening", entry.kind + "." + check.id + "." + override.key + "=" + js(override.to), answer, at)
      rubric.json.pass = true
      rubric.json.countersigned = true
    }
  }
  if (!rubric.json.pass) {
    await sendBack("rubric", js({
      gateLooseningsDenied: rubric.json.checksPass && rubric.json.loosenings?.length > 0,
      loosenings: rubric.json.loosenings ?? [],
      profiles: rubric.json.profiles.map((entry) => ({ kind: entry.kind, skipReason: entry.skipReason, failures: entry.rubric.failures, integrationDiff: entry.integrationDiff })),
    }))
    continue
  }
  const flagKey = (flag) => flag.rule + " " + flag.file + ":" + flag.line
  const blockingFlags = integrityReport.flags.filter((flag) => flag.severity !== "warn" && !countersigns.some((sign) => sign.kind === "integrity-flag" && sign.subject === flagKey(flag)))
  const firstSeen = blockingFlags.filter((flag) => !flagsSentBack.has(flagKey(flag)))
  if (firstSeen.length > 0) {
    for (const flag of firstSeen) flagsSentBack.add(flagKey(flag))
    await sendBack("rubric", "Integrity flags to remove (or explain why each is needed): " + js(firstSeen))
    continue
  }
  if (blockingFlags.length > 0) {
    const answer = await ask(
      "Integrity flags on " + item.id + ":\n" + blockingFlags.map((flag) => flagKey(flag) + " " + flag.detail).join("\n") +
      "\nReply 'no' to send the item back, or write the reason you countersign all of them.",
    )
    const reason = trimmed(answer)
    if (!reason || reason.toLowerCase() === "no") {
      await sendBack("rubric", "Integrity flags to remove: " + js(blockingFlags))
      continue
    }
    for (const flag of blockingFlags) {
      countersign("integrity-flag", flagKey(flag), reason)
    }
  }

  let growth = null
  if (previousHead !== baseSha) {
    const before = await diffSize(previousHead)
    const after = await diffSize(report.head)
    if (before === null || after === null) return blockHere("could not measure diff growth")
    if (after > before * growthFactor) {
      const findings = openFindings().filter((finding) => BLOCKING.includes(finding.severity))
      if (!findings.length) return stopHere("draft", "unexplained diff growth exceeds critique.growthFactor; lead review required", { before, after, growthFactor, critique: ledger })
      const diff = await runInWorktree(["diff", "--no-color", "--no-ext-diff", "--no-renames", "--unified=0", previousHead, report.head, "--", ...reviewPolicy.json.pathspec])
      if (!diff.ok) return blockHere("could not inspect diff growth")
      let file = ""
      const hunks = []
      for (const line of diff.detail.split("\n")) {
        if (line.startsWith("diff --git ")) file = line
        else if (line.startsWith("@@ ") || line.startsWith("Binary files ")) hunks.push(file + "\n" + line)
      }
      growth = growthEvidence({ hunks, before, after, growthFactor, previousHead, head: report.head, findings, rounds: ledger.rounds })
    }
  }
  let outcome = await critique(report.head, report, growth)
  while (outcome.parsed && !outcome.parsed.error) {
    const reason = await reviewCalculation("drift", { scores: outcome.parsed.scores, firstScores, driftTolerance: String(driftTolerance) })
    if (!reason) break
    ledger.rounds.push({ round: critiqueRound, critic, log: outcome.log, diffStat: outcome.diffStat, gaming: outcome.parsed.gaming, scores: outcome.parsed.scores, void: true, voidReason: reason })
    voidStreak += 1
    await saveState()
    if (voidStreak >= 2) return stopHere("draft", "two void critique rounds in a row; the human decides", { critique: ledger })
    outcome = await critique(report.head, report, growth)
  }
  voidStreak = 0
  if (outcome.owner) { await sendBack("rubric", "Fix your exemplars: " + outcome.parsed.error); continue }
  if (!outcome.parsed || outcome.parsed.error) {
    return blockHere("the critic reply at " + outcome.log + " could not be read: " + (outcome.parsed?.error ?? "no output"), { critique: ledger })
  }
  const parsed = outcome.parsed
  if (growth) {
    const justified = justifiedGrowth({ growth, explanations: outcome.growthReview?.hunks })
    if (!justified) {
      await saveState()
      return stopHere("draft", "unexplained diff growth exceeds critique.growthFactor; lead review required", { growth, growthReview: outcome.growthReview, log: outcome.log, critique: ledger })
    }
  }
  if (!firstScores) firstScores = parsed.scores
  ledger.rounds.push({ round: critiqueRound, critic, log: outcome.log, diffStat: outcome.diffStat, gaming: parsed.gaming, scores: parsed.scores })
  for (const id of parsed.resolved) {
    const finding = ledger.findings.find((entry) => entry.id === id)
    if (finding && (finding.status === "open" || finding.status === "disputed")) {
      finding.status = "resolved"
      delete finding.reason
    }
  }
  for (const raised of parsed.findings) {
    if (!ledger.findings.some((entry) => entry.id === raised.id)) ledger.findings.push({ id: raised.id, severity: raised.severity, status: "open", round: critiqueRound })
  }
  previousHead = report.head
  const reasons = await reviewCalculation("verdict", { parsed, threshold, findings: openFindings() })
  if (reasons.length > 0) {
    await sendBack("critique", "Critique " + outcome.log + " (read it in the worktree). Open findings: " + openFindings().map((finding) => finding.id).join(", ") + ". Why it was sent back: " + reasons.join("; "))
    continue
  }

  phase("Approval")
  if (proposalStage) {
    if (withProposal.length && !approvedProposals.length) return blockHere("proposal artifacts are missing")
    const frozen = proposalCandidate
    const reviewProblem = await verifyInputs(frozen.inputs)
    if (reviewProblem) return reviewProblem
    let by, reason
    if (proposalApprover === "human") {
      const answer = await ask("Approve the proposal for " + item.id + "? Files: " + (approvedProposals.length ? approvedProposals.join(", ") : snapshotPath) + " in " + worktree, ["approve", "reject"])
      if (answer !== "approve") return stopHere("draft", "the proposal was not approved")
      const identity = await ask("Who approves this proposal? Enter the approver identity.")
      by = trimmed(identity)
      if (!by) return blockWith("approval needs an approver identity")
      reason = "the human explicitly approved the proposal before integration"
    } else {
      const decision = await supervise(report.exemplars ?? [])
      if (decision?.approved !== true || decision.restatementMatches !== true || !trimmed(decision.reason)) return stopHere("draft", "the supervisor did not approve the proposal or confirm the restatement: " + (decision?.reason ?? "no valid decision"))
      by = critic
      reason = decision.reason.trim()
    }
    const approvalProblem = await approvedItemProblem(frozen.inputs)
    if (approvalProblem) return approvalProblem
    const anchorProblem = await verifyInputs(JSON.parse(exemplarIdentity))
    if (anchorProblem) return anchorProblem
    proposalApproval = { approver: proposalApprover, by, reason, artifacts: approvedProposals, at: new Date().toISOString(), head: report.head, inputs: frozen.inputs }
    await writeJson(evidencePath("proposal-approval.json"), proposalApproval)
    await writeJson(approvalPath, { item: item.id, proposal: proposalApproval })
    proposalStage = false
    previousHead = baseSha
    feedback = null
    await saveState()
    phase("Rounds")
    continue
  }
  const needsHuman = plan.profiles.some((profile) => profile.humanApproval === true) || plan.suggested.includes("ui") || item.visual === true || item.art === true || report.card?.proof?.changeType === "ui"
  if (needsHuman) {
    const answer = await ask("Item " + item.id + " passed critique at " + report.head + " in " + worktree + ". Approve the result?", ["approve", "send back"])
    if (answer !== "approve") {
      const change = await ask("What should change in " + item.id + "?")
      await sendBack("human", "The human sent it back: " + change)
      phase("Rounds")
      continue
    }
    const identity = await ask("Who approves this result? Enter the approver identity.")
    const by = trimmed(identity)
    if (!by) return blockWith("approval needs an approver identity")
    resultApproval = { by, at: new Date().toISOString(), head: report.head }
  }
  const finalApprovalProblem = await approvedItemProblem(proposalApproval?.inputs)
  if (finalApprovalProblem) return finalApprovalProblem
  accepted = report
}

await saveState()
const reviewedExemplars = JSON.parse(exemplarIdentity)
for (const inputs of [reviewedExemplars, critiqueIdentities]) {
  const problem = await verifyInputs(inputs)
  if (problem) return problem
}

for (const finding of ledger.findings) {
  if (finding.status === "open" && finding.severity === "nit") Object.assign(finding, { status: "declined", reason: "nit left for a later item; not worth another round" })
}

const lastCounted = ledger.rounds.filter((entry) => !entry.void).pop()
const { critiqueScores, profileEvidence } = await reviewCalculation("final", { profiles: plan.profiles, scores: lastCounted.scores, accepted, proposalEvidence })

const result = {
  state: "critiqued",
  item: item.id,
  rung: preflight.json.rung,
  risk: preflight.json.tier,
  grant: preflight.json.grant,
  itemPath,
  worktree,
  branch,
  baseSha,
  headSha: accepted.head,
  reviewPolicy: policyBinding,
  restatement,
  owner: { session: accepted.session, model: workerModel ?? "workflow role" },
  engine: engine ?? "native",
  exemplars: accepted.exemplars ?? [],
  approvedProposals,
  profileEvidence,
  proposalApproval,
  resultApproval,
  commands: accepted.commands ?? [],
  card: accepted.card ?? {},
  checkResults: accepted.checkResults,
  critique: ledger,
  critiqueScores,
  critic,
  countersigns,
  rounds: { used: rejectedBy.length, budget: plan.roundBudget, rejectedBy },
  plan,
}
await writeJson(evidencePath("quality.json"), result)
const qualityIdentity = await approvalInputs("snapshot", [
  { path: evidenceDir + "/quality.json" },
])
if (!qualityIdentity.pass) return blockWith(qualityIdentity.error)
const logProblem = await verifyInputs(critiqueIdentities)
if (logProblem) return logProblem
await writeJson(approvalPath, { item: item.id, proposal: proposalApproval, result: resultApproval, quality: [...qualityIdentity.inputs, ...critiqueIdentities, ...reviewedExemplars] })
return result
