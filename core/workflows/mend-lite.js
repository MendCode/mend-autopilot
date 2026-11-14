export const meta = {
  name: "mend-lite",
  description: "One work item, light path: the strong model specs it, one cheap owner implements and commits, the workflow verifies, the strong model reviews, one fix round",
  phases: [
    { title: "Plan", detail: "worktree and planner spec" },
    { title: "Build", detail: "owner implements; workflow runs verification, scope and integrity" },
    { title: "Review", detail: "strong reviewer; a blocker sends one fix round" },
  ],
  budget: { agents: 8, minutes: 180 },
  permission: "edits",
  maxConcurrent: 1,
}

// Arguments:
//   repo       absolute path of the user's repository (holds .mend/)
//   item       the work item JSON (.mend/items/<id>.json); needs id, goal and editSet
//   pkg        the installed mend-autopilot package folder; relative item/pkg resolve against repo
//   critic     strong model: writes the spec (unless planner is set) and reviews
//   planner    optional strong model for the spec only
//   model      the cheap owner's model; engine optional, as in mend-quality
//   fixRounds  owner rounds after the first, default 1, at most 3
//   auditFeedback  what the auditor found at the reviewed head; one more owner round starts from it
// Profiles, proposals and lead captures belong to mend-quality; this path is for items a
// cheap owner can finish from a written spec. The human approves the result before merge.

const js = JSON.stringify
const STR = { type: "string" }
const shape = (properties) => ({ type: "object", required: Object.keys(properties), properties })
const trimmed = (value) => typeof value === "string" ? value.trim() : ""

function required(name) {
  const value = trimmed(args[name])
  if (!value) throw new Error("[MEND-LITE]: argument " + name + " is required")
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
const critic = normalizeModel(required("critic"))
const planner = normalizeModel(trimmed(args.planner)) || critic
const engine = trimmed(args.engine) || null
const workerModel = normalizeModel(trimmed(args.model)) || null
if (engine && engine.startsWith("acp")) throw new Error("[MEND-LITE]: workflows do not accept ACP")
if (engine && engine !== "native" && !workerModel) throw new Error("[MEND-LITE]: argument model is required with engine " + engine)
const fixRounds = Number(args.fixRounds ?? 1)
if (!Number.isInteger(fixRounds) || fixRounds < 0 || fixRounds > 3) throw new Error("[MEND-LITE]: fixRounds must be an integer from 0 to 3")
const auditFeedback = trimmed(args.auditFeedback).slice(0, 6000)

const placed = (options, model) => Object.assign({}, options, (model ?? workerModel) ? { model: model ?? workerModel } : {}, engine ? { engine } : {})
// Planner and reviewer only read: no skills from the user's profiles, which pull them outside the item.
// Only the native engine enforces an allowlist; other engines refuse the option.
const READ_TOOLS = !engine || engine === "native" ? { allowedTools: ["read", "grep", "glob"] } : {}
const reader = (options, model) => placed(Object.assign({ mode: "read" }, options, READ_TOOLS), model)

const quote = (value) => "'" + String(value).split("'").join("'\"'\"'") + "'"
let policyBinding = null
const tool = (script, rest, text) => ({ command: "node " + quote(pkg + "/checks/" + script) + " --stdin", stdin: js({ args: rest, policy: policyBinding, text }) })
const host = (operation, data) => tool("workflow-host.mjs", [operation, js(data)])
const git = (values, cwd) => host("git", { args: values, cwd })

function jsonOutput(text) {
  const source = String(text ?? "").trim()
  try { return JSON.parse(source) } catch {}
  for (const line of source.split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue
    try { return JSON.parse(line.trim()) } catch { return null }
  }
  return null
}

async function run({ command, stdin }) {
  if (command.length > 300 || /[;&|<>`$\\\n\r]/.test(command)) throw new Error("package path cannot be represented by check()")
  const result = await check(command, { stdin })
  if (result.truncated) throw new Error("[MEND-LITE]: output of a host command was truncated by the runtime: " + command.slice(0, 120))
  const detail = String(result.detail ?? "").replace(/^exit -?\d+\n?/, "")
  return { ok: result.ok, detail, json: jsonOutput(detail) }
}

async function writeText(file, text) {
  const result = await run(tool("write-file.mjs", [file], text))
  if (!result.ok) throw new Error("[MEND-LITE]: could not write " + file + ": " + result.detail.slice(-300))
}
const writeJson = (file, value) => writeText(file, js(value, null, 2))
async function readJson(file) {
  const result = await run(host("read-json", { file }))
  return result.ok ? result.json : null
}
const lastLine = (text) => String(text ?? "").trim().split("\n").pop()

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

async function promptFor(kind, data) {
  const result = await run(tool("lite-prompts.mjs", [kind, js(data)]))
  if (!result.ok || typeof result.json?.prompt !== "string") throw new Error("[MEND-LITE]: prompt construction failed: " + kind + ": " + result.detail.slice(-300))
  return result.json.prompt
}

phase("Plan")

const top = await run(git(["rev-parse", "--show-toplevel"], repo))
const repoRoot = lastLine(top.detail)
if (!top.ok || !repoRoot.startsWith("/")) return stopWith("blocked", "could not resolve the repository root: " + top.detail.slice(-300))
const item = await readJson(itemPath)
if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.id)) return stopWith("blocked", "the item file " + itemPath + " is missing or has no valid id")
const editSet = Array.isArray(item.editSet) ? item.editSet.map(String).filter(Boolean) : []
if (!editSet.length) return stopWith("blocked", "the item has no editSet; the lead writes one before dispatch")
const ignored = await run(git(["check-ignore", "-q", ".mend/worktrees/probe"], repoRoot))
if (!ignored.ok) return stopWith("blocked", "add .mend/ to .gitignore before dispatch; evidence and worktrees live there")
const verification = await readJson(repoRoot + "/.mend/evidence/verify.json")
if (!Array.isArray(verification?.steps) || !verification.steps.length || verification.steps.some((step) => !trimmed(step?.command) || step.exit !== 0)) return stopWith("blocked", "the verification record must list every passing verification command")
const verificationCommands = [...new Set(verification.steps.map((step) => step.command.trim()))]

const worktree = repoRoot + "/.mend/worktrees/" + item.id
const branch = "mend/" + item.id
const stopHere = (state, reason, extra) => stopWith(state, reason, { worktree, branch, ...extra })
const inWorktree = (values) => run(git(values, worktree))
const pathPreflight = await run(host("worktree-preflight", { cwd: repoRoot }))
if (!pathPreflight.ok) return stopWith("blocked", "unsafe worktree setup: " + pathPreflight.detail.slice(-300))
const evidenceDir = ".mend/evidence/" + item.id
const evidencePath = (name) => worktree + "/" + evidenceDir + "/" + name
const stateFile = evidencePath("lite-state.json")
const exists = await run(host("exists", { file: worktree, directory: true }))
let saved = null
if (exists.ok) {
  saved = await readJson(stateFile)
  if (!saved || saved.item !== item.id || !/^[0-9a-f]{40}$/.test(saved.baseSha ?? "") || !trimmed(saved.spec)) return stopHere("blocked", "the worktree exists without a valid mend-lite state; remove it or recover its evidence")
}
let baseSha = saved?.baseSha
if (!saved) {
  // An item may name its base (origin/main): an independent change starts there, not on the branch checked out.
  const baseRef = trimmed(item.base) || "HEAD"
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(baseRef)) return stopWith("blocked", "the item base must be a branch or commit name")
  baseSha = lastLine((await run(git(["rev-parse", "--verify", baseRef + "^{commit}"], repoRoot))).detail)
  if (!/^[0-9a-f]{40}$/.test(baseSha)) return stopWith("blocked", "could not read the base commit " + baseRef)
  const added = await run(git(["worktree", "add", "-b", branch, worktree, baseSha], repoRoot))
  if (!added.ok) return stopWith("blocked", "git worktree add failed: " + added.detail.slice(-300))
}
const setup = await run(tool("dispatch.mjs", ["propagate", "--repo", repoRoot, "--item", itemPath, "--light", "yes"]))
// Untracked copies of the setup this workflow propagated are not the worker's leftovers.
const setupPaths = new Set(Array.isArray(setup.json?.setup) ? setup.json.setup.map(String) : [])
const workerChanges = (porcelain) => String(porcelain).split("\n").filter((line) => line.trim() && !(line.startsWith("?? ") && setupPaths.has(line.slice(3).trim()))).join("\n")
if (!setup.ok || setup.json?.pass !== true) return stopHere("blocked", setup.json?.reason ?? "worktree setup failed")
policyBinding = saved?.reviewPolicy ?? null
const reviewPolicy = await run(tool("review-policy.mjs", [worktree, baseSha]))
if (!reviewPolicy.ok || !Array.isArray(reviewPolicy.json?.pathspec)) return stopHere("blocked", "could not load the review exclusions: " + reviewPolicy.detail.slice(-300))
policyBinding = reviewPolicy.json
const pathspec = reviewPolicy.json.pathspec

const base = { item, worktree, verificationCommands }
const specPath = evidenceDir + "/spec.md"
let spec = trimmed(saved?.spec)
if (!spec) {
  const reply = await agent(await promptFor("spec", base), reader({ label: "spec " + item.id, phase: "Plan", schema: {
    type: "object", required: ["spec"], properties: { spec: STR, editSetMissing: { type: "array", items: STR } },
  } }, planner))
  spec = trimmed(reply?.spec)
  if (!spec) return stopHere("blocked", "the planner returned no spec")
  // A too-narrow editSet is the lead's to widen; owner rounds cannot fix it.
  const missing = (Array.isArray(reply.editSetMissing) ? reply.editSetMissing : []).map(trimmed).filter((file) => file && !editSet.some((glob) => globRegExp(glob).test(file)))
  if (missing.length) {
    await writeText(worktree + "/" + evidenceDir + "/spec-draft.md", spec + "\n")
    return stopHere("draft", "the planner says the item needs files outside its editSet: " + missing.join(", ") + "; widen the editSet (or split the item) and rerun after removing this worktree", { editSetMissing: missing, spec: evidenceDir + "/spec-draft.md" })
  }
}
// Markdown, not one long JSON line: readers cut long lines.
await writeText(worktree + "/" + specPath, spec + "\n")
const state = saved ?? { item: item.id, baseSha, planner, critic, spec, reviewPolicy: policyBinding, budget: 1 + fixRounds, rounds: [] }
const saveState = () => writeJson(stateFile, state)
await saveState()

async function verify(round) {
  // An owner may have removed the untracked setup; restore it so verification runs what was recorded.
  const restored = await run(tool("dispatch.mjs", ["propagate", "--repo", repoRoot, "--item", itemPath, "--light", "yes"]))
  if (!restored.ok || restored.json?.pass !== true) return { blocked: "could not restore the worktree setup before verification: " + (restored.json?.reason ?? restored.detail.slice(-300)) }
  const results = []
  for (let index = 0; index < verificationCommands.length; index += 1) {
    const command = verificationCommands[index]
    const guard = await run(host("guard", { cwd: worktree, command }))
    if (!guard.ok) return { blocked: "the guard refuses a verification command: " + guard.detail.slice(-300) }
    const logFile = evidenceDir + "/verify-r" + round + "-" + (index + 1) + ".log"
    const executed = await run(host("execute", { cwd: worktree, command, file: logFile }))
    const captured = await run(host("read", { cwd: worktree, file: logFile }))
    const match = /(?:^|\n)exit: (\d+)\s*$/.exec(captured.detail)
    const exit = executed.ok && captured.ok && match ? Number(match[1]) : 1
    results.push({ command, exit, log: logFile, tail: exit === 0 ? "" : captured.detail.slice(-1500) })
  }
  return { results }
}

async function inspect(round) {
  const head = lastLine((await inWorktree(["rev-parse", "HEAD"])).detail)
  const status = await inWorktree(["status", "--porcelain", "--untracked-files=all", "--", ...pathspec])
  const names = await inWorktree(["diff", "--name-only", baseSha, head, "--", ...pathspec])
  const files = names.ok ? names.detail.trim().split("\n").filter(Boolean) : []
  const problems = []
  if (!/^[0-9a-f]{40}$/.test(head)) problems.push("could not read the head commit")
  if (head === baseSha) problems.push("nothing was committed: no change was made, so the whole spec is still yours to implement, starting now")
  const leftover = status.ok ? workerChanges(status.detail) : "status could not be read"
  if (leftover) problems.push("uncommitted changes remain: " + leftover.slice(0, 400))
  const outside = files.filter((file) => !editSet.some((glob) => globRegExp(glob).test(file)))
  if (outside.length) problems.push("files outside the editSet changed: " + outside.join(", "))
  const checked = await verify(round)
  if (checked.blocked) return { blocked: checked.blocked }
  const failed = checked.results.filter((result) => result.exit !== 0)
  if (failed.length) problems.push("repository verification failed: " + js(failed.map(({ command, exit, tail }) => ({ command, exit, tail }))))
  let integrity = null
  if (/^[0-9a-f]{40}$/.test(head) && head !== baseSha) {
    const scan = await run(tool("integrity.mjs", ["--base", baseSha, "--head", head, "--item", itemPath, "--repo", worktree, "--json"]))
    integrity = scan.json
    const blocking = Array.isArray(integrity?.flags) ? integrity.flags.filter((flag) => flag?.severity === "block") : []
    if (!scan.json) problems.push("the integrity scan did not report: " + scan.detail.slice(-300))
    else if (blocking.length) problems.push("integrity flags to remove (weakened or skipped tests, secrets, scope): " + js(blocking))
  }
  // A declared regression must fail at base and pass at head, run by the workflow in clean checkouts.
  let redGreen = null
  if (regression && !problems.length) {
    const result = await run(tool("red-green.mjs", ["--base", baseSha, "--head", head, "--cmd", regression, "--repo", worktree, "--item", itemPath, ...regressionOptions, "--json"]))
    redGreen = { command: regression, pass: result.json?.pass === true, baseExit: result.json?.base?.exit ?? result.json?.baseExit, headExit: result.json?.head?.exit ?? result.json?.headExit }
    if (!redGreen.pass) problems.push("the regression " + regression + " must fail at base and pass at head: " + String(result.json?.reason ?? result.detail).slice(-500))
  }
  return { head, files, verification: checked.results, integrity, redGreen, problems }
}
const regression = [item.regressionCommand, item.regression].map(trimmed).find(Boolean) ?? ""
// The same red-green options mend-pr passes: a setup the clean checkouts need (dependencies, a database),
// the base failure to expect, a keep command and a timeout.
const regressionOptions = [
  ...(trimmed(item.regressionSetup) ? ["--setup", trimmed(item.regressionSetup)] : []),
  ...(trimmed(item.regressionKeep) ? ["--keep", trimmed(item.regressionKeep)] : []),
  ...(typeof item.regressionExpect === "string" ? ["--expect-base", item.regressionExpect] : []),
  ...(Number.isFinite(item.regressionTimeoutMs) && item.regressionTimeoutMs > 0 ? ["--timeout-ms", String(item.regressionTimeoutMs)] : []),
]

async function deliveryRisk(head) {
  const result = await run(tool("dispatch.mjs", ["delivery", "--repo", repoRoot, "--item", itemPath, "--base", baseSha, "--head", head, "--light", "yes"]))
  return result.json?.pass === true ? { tier: result.json.tier, rung: result.json.rung, rule: result.json.riskRule ?? null } : { error: result.json?.reason ?? result.detail.slice(-300) }
}

phase("Build")

// A rerun of a finished item returns its result instead of judging it again.
const finished = state.rounds.at(-1)
if (finished?.review?.verdict === "merge" && !auditFeedback) {
  const card = await readJson(evidencePath("lite-card.json"))
  if (card?.state === "reviewed" && card.head === finished.head) return stopHere("reviewed", "already reviewed at " + card.head + "; a human approves before the pull request", { head: card.head, baseSha, card: evidenceDir + "/lite-card.json", review: card.review, risk: card.risk, redGreen: card.redGreen })
}

// An audit finding gets exactly one more round on top of the review rounds already spent.
const auditRound = Boolean(auditFeedback) && finished?.review?.verdict === "merge"
let feedback = auditRound ? "The reviewer approved your last head, but the independent auditor found problems there. Fix them, keep everything the review approved, and commit:\n" + auditFeedback : state.rounds.at(-1)?.feedback ?? null
let lastReview = null
const lastAllowed = auditRound ? state.rounds.length + 1 : 1 + fixRounds
for (let round = state.rounds.length + 1; round <= lastAllowed; round += 1) {
  let ownerNote = ""
  let ownerSession = ""
  try {
    const result = await agent(await promptFor("owner", { ...base, specPath, round, feedback }), placed({ label: "owner " + item.id + " r" + round, phase: "Build", mode: "work", detail: true }))
    ownerNote = String(result?.text ?? "").slice(-1500)
    ownerSession = trimmed(result?.taskId)
  } catch (error) {
    // An owner that stops early still leaves commits; the workflow judges what is there.
    ownerNote = "owner stopped: " + String(error?.message ?? error).slice(-600)
  }
  const inspected = await inspect(round)
  if (inspected.blocked) return stopHere("blocked", inspected.blocked, { rounds: state.rounds })
  const entry = { round, head: inspected.head, files: inspected.files, verification: inspected.verification, integrity: inspected.integrity, redGreen: inspected.redGreen, problems: inspected.problems, ownerNote, ...(ownerSession ? { ownerSession } : {}) }
  if (inspected.problems.length === 0) {
    phase("Review")
    const diffPath = evidenceDir + "/diff-r" + round + ".patch"
    const prompt = await promptFor("critique", { ...base, specPath, diffPath, baseSha, head: inspected.head, pathspec, verification: inspected.verification.map(({ command, exit }) => ({ command, exit })), round })
    const review = await agent(prompt, reader({ label: "critique " + item.id + " r" + round, phase: "Review", schema: {
      type: "object", required: ["verdict", "summary", "findings"],
      properties: { verdict: { enum: ["merge", "fix"] }, summary: STR, findings: { type: "array", items: shape({ severity: { enum: ["blocker", "nit"] }, file: STR, issue: STR }) } },
    } }, critic))
    const blockers = Array.isArray(review?.findings) ? review.findings.filter((finding) => finding?.severity === "blocker") : []
    if (!review || !Array.isArray(review.findings)) return stopHere("blocked", "the reviewer returned no valid review", { rounds: state.rounds })
    // Only blockers send work back; nits ride along to the human.
    lastReview = { verdict: blockers.length ? "fix" : "merge", summary: trimmed(review.summary), findings: review.findings }
    entry.review = lastReview
    entry.diff = diffPath
    if (lastReview.verdict === "merge") {
      state.rounds.push(entry)
      await saveState()
      const risk = await deliveryRisk(inspected.head)
      if (risk.error) return stopHere("blocked", "delivery authorization failed: " + risk.error, { rounds: state.rounds })
      const card = { item: item.id, state: "reviewed", baseSha, head: inspected.head, branch, planner, critic, owner: workerModel, spec: specPath, risk, redGreen: inspected.redGreen, rounds: state.rounds, review: lastReview }
      await writeJson(evidencePath("lite-card.json"), card)
      return stopHere("reviewed", "verification passes and the reviewer would merge; a human approves before the pull request", { head: inspected.head, baseSha, card: evidenceDir + "/lite-card.json", review: lastReview, risk, redGreen: inspected.redGreen })
    }
    entry.feedback = "The reviewer sent it back (" + diffPath + "). Blockers:\n" + js(blockers)
  } else {
    entry.feedback = "The workflow found problems at your head:\n- " + inspected.problems.join("\n- ")
  }
  feedback = entry.feedback
  state.rounds.push(entry)
  await saveState()
}

const final = state.rounds.at(-1)
await writeJson(evidencePath("lite-card.json"), { item: item.id, state: "draft", baseSha, head: final?.head, branch, planner, critic, owner: workerModel, spec: specPath, rounds: state.rounds, review: lastReview })
return stopHere("draft", "rounds spent: " + (final?.problems?.length ? final.problems.join("; ").slice(0, 600) : "the reviewer still finds blockers"), { head: final?.head, baseSha, card: evidenceDir + "/lite-card.json", review: lastReview })
