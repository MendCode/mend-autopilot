# Development

How the repository is laid out, how the packages are built and tested, and what the workflows expect from the MendCode host.

## Layout

```text
core/                  shared source: skills, playbooks, guard, checks, workflows, evidence card, profiles
adapters/<harness>/    per-harness manifest, recipes, setup command, hook wiring, MAPPING.md
build.mjs              assembles dist/mend-autopilot-<harness>/ from core + one adapter
build/                 build configuration (not shipped)
scripts/verify.sh      the full local test suite
scripts/render-assets.mjs  the README images in docs/assets/
docs/                  documentation
dist/                  generated packages (git-ignored)
```

When a file exists in both `core/` and `adapters/<harness>/`, the adapter copy wins. Each adapter's `MAPPING.md` says what every core role, step and path is on that harness.

| Part | What it is |
|---|---|
| `core/skills/mend-mode` | The lead's playbook: item format, autonomy ladder, mandatory stops, dispatch and blocker triage. |
| `core/skills/mend-quality`, `mend-ship` | The full path's quality loop and the evidence card with its JSON schema. |
| `core/skills/create-verification`, `maintain-verification` | Writing and keeping the project's verification skill, the commands that prove the project works. |
| `core/workflows/` | `mend-lite`, `mend-lite-pr`, `mend-quality` and `mend-pr`, MendCode workflow scripts. |
| `core/checks/` | The programs the workflows call: red-green, the integrity scan (which also enforces the edit set), the rubric runner, the card check, dispatch, critic replies and the guarded command runner. |
| `core/profiles/` | Work profiles (bugfix, ui, refactor, docs, api-backend, schema-migration, generic) with executable rubrics. |
| `core/guard/` | The pre-tool guard and its tests. |

## Build and test

Requires Node 20+ (or Bun), Python 3.9+ and git. There are no dependencies.

```sh
node build.mjs codex          # or claude, opencode-go, all
node build.mjs all --check    # compare dist/ with the sources; writes nothing
scripts/verify.sh             # guard tests, all Node tests, profiles, build, package check
node scripts/render-assets.mjs           # rewrite docs/assets/ from the templates
node scripts/render-assets.mjs --check   # exit 1 if an image differs from its template
```

Build exit codes:

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | `dist/` differs from the sources (`--check`) |
| 2 | Invalid source tree: a symlink, a path traversal, a bad manifest or a missing denylist |
| 3 | Leak check hit |
| 64 | Usage error |

The build writes nothing on any code other than 0. It replaces a package folder only after the new copy has been written in full.

### Leak check

Each build and each `--check` scans every file that would ship, along with `README.md` and `docs/`, and stops with `file:line` on a hit. The rules come from `build/leak-denylist.json` (home-directory paths and similar) plus, when present, a git-ignored `build/leak-denylist.local.json` for names that must never ship and should not be published either. Neither file ships.

## Workflow host

The workflows were exercised on MendCode `0.0.1-dev`. They need a host whose workflow `check()` accepts `{ stdin }`; an older host refuses them.

- Every workflow takes `repo=<absolute path>`: the repository that holds `.mend/`, not the host's scratch checkout. Relative `item` and `pkg` paths resolve against it.
- `check` is not a shell. The workflows invoke only `node '<package>/checks/<tool>.mjs' --stdin`; paths, JSON, prompts and commands travel on stdin as `{ "args": [...], "policy": null }`, within the host's 1 MB limit.
- Verification commands run inside `checks/workflow-host.mjs`, and only after the guard allows them. Git runs with argument arrays.
- Workflows cannot use `import()`; shared logic lives in `checks/*.mjs` and is called through `check`.
- Workflows refuse ACP agents. Agents on the Claude Code engine need the full tier and an exact model.

Measured harness capabilities and their limits are in [harness-matrix.md](harness-matrix.md).
