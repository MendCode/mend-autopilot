# Safety setup

mend-autopilot ships a pre-tool guard, `guard/mend_guard.py`. It runs before every tool call and blocks the destructive or out-of-scope ones. It is a seatbelt, not a sandbox. Real isolation comes from your harness permissions and from the deny rules below, which you set yourself. A package cannot change permissions, and this one does not try to.

## Approval prompts

In MendCode's default smart mode, reads inside the project and its own test and build commands normally run without a prompt. Reads of the installed package outside the project and other commands may request approval. Review each request; for repeated trusted operations choose **For this session** on the approval card, if offered. Alternatively, you can add a narrowly scoped allow rule for reading the installed package directory in your harness permissions. Do not allow writes or shell execution just to allow reads. You apply these choices yourself; neither setup nor the package changes permissions. Deny rules and the guard still apply, and script contents must be reviewed separately.

## How the guard works

- The harness sends the tool call to the guard as a JSON event on stdin. The adapter for your harness wires this up; see its `MAPPING.md`.
- Exit code `0` lets the call run. Exit code `2` blocks it, and the reason is printed on stderr:

  ```text
  [MEND-GUARD]: git-force: force push rewrites remote history. Instead: push normally, or use --force-with-lease on your own mend/* branch
  ```

- It uses only the Python standard library and runs as `python3 -I mend_guard.py`. It opens no network connection and starts no process. It needs Python 3.9 or later.
- With `--mend-only` (the Claude Code plugin passes it, because a Claude Code hook runs in every session on the machine) the guard acts only when the call's folder is inside a repository with a `.mend/` folder, the repository itself or one of its item worktrees, and lets every other call through.
- Paths are resolved to their real location before they are compared, so `/tmp/x` and `/private/tmp/x` count as the same folder.
- An event the guard cannot read is let through with a warning on stderr. A broken hook must not stop the session, and the deny rules below still apply.
- Internal regression/setup, capture and repository-check shell runners explicitly preflight the guard before spawning a shell. A refusal, warning, missing runtime, timeout or failed preflight blocks execution. Temporary regression worktrees resolve command paths locally but load guard settings from the source checkout via `--config-cwd`.

## Rules

The first rule that matches blocks the call.

| Rule | Blocks | Still allowed |
|---|---|---|
| `db-destroy` | `DROP`, `TRUNCATE` or a `DELETE FROM` with no `WHERE` sent to a database client; `dropdb`, `prisma migrate reset`, `rails db:drop`, `manage.py flush`, `supabase db reset`, `FLUSHALL` | Reads, a `DELETE` with a `WHERE` clause, `CREATE TABLE`, and grepping SQL text |
| `rm-outside` | `rm -r` or `find -delete` outside the session worktree or its registered temporary directories, on the whole worktree, on `.git`, on the shared temp folder, on a path built from a variable, or after a `cd` the guard cannot follow | `rm -r` inside the worktree, on a temp subfolder registered for this task's session, and a plain `rm` of single files |
| `git-force` | `push --force`, `-f` or a `+ref`; `--force-with-lease` with no branch named or onto trunk | `--force-with-lease origin mend/<item>` |
| `git-reset-hard` | `reset --hard` | `reset --soft`, `restore`, `stash` |
| `git-clean` | `clean -f` without `-n` | `clean -n` |
| `trunk-delete` | Deleting `main`, `master`, `trunk`, `develop`, `production`, `prod` or `release`, locally or on the remote | Deleting your own `mend/*` branches |
| `global-install` | `sudo`, system package managers (`brew install`, `apt-get`…), `npm -g`, `pip --user`, `cargo install`, `go install`, `uv tool install` | Project-local installs that the dependency rule allows |
| `dependency-ungranted` | Adding a named package (`pnpm add x`, `pip install x`, `go get x`…) that has no recorded grant | Lockfile installs (`pnpm install`, `npm ci`, `pip install -r`) and granted names |
| `secret-read` | Reading `.env*`, `.envrc`, `.netrc`, `.npmrc`, SSH, AWS or GPG folders, private keys, `credentials.json` and `secrets.*`, from the shell or a file-read tool | `.env.example` and other template files; `ls`; copying a template *to* `.env`; appending to `.env.local` |
| `pipe-to-shell` | `curl … \| sh`, `bash <(curl …)`, a download piped into an interpreter | Downloading to a file so it can be read first |
| `docker-prune` | `docker … prune`, `compose down -v` | `compose down`, `docker ps` |
| `kubectl-delete` | `kubectl delete`, `helm uninstall` | `kubectl get` and `describe` |
| `infra-destroy` | `terraform destroy` | `terraform plan` |
| `production-pattern` | Any command or file path that matches a pattern you list for the repo | Everything else |

Free text inside `git commit`, `git tag`, `gh pr` and `gh issue` never triggers a command rule. A commit message such as "drop unused import" is fine.

## Repository settings

Create `<repo>/.mend/guard.json` when you need it. Every field is optional:

```json
{
  "productionPatterns": ["db\\.prod\\.internal", "api\\.example\\.com"],
  "allowDependencyAdds": false,
  "grantedDependencies": ["zod", "@scope/ui-kit"],
  "temporaryDirectories": {"session-for-item-123": ["/tmp/mend-item-123-scratch"]},
  "leadCaptureSessions": ["lead-session-id"]
}
```

- `productionPatterns` are case-insensitive regular expressions. An invalid pattern is skipped with a warning.
- `grantedDependencies` lists the package names you have approved. The version spec is ignored, so a grant for `zod` covers `zod@^3`.
- `allowDependencyAdds: true` turns the dependency rule off for the repo.
- `temporaryDirectories` maps the hook's exact `session_id` to absolute, task-owned temporary folders. The operator or trusted orchestrator records the folder after creating it for that item and removes the registration at handoff; never share a session across concurrent items or let the owner self-grant paths. No registration or no session ID means no external-temp deletion exception. Shared temp roots, relative paths and globs cannot be registered; symlink targets and `..` are resolved before containment checks. The guard trusts this configuration, not folder names or a claim in tool input.
- `leadCaptureSessions` lists exact hook `session_id` values authorized to invoke evidence capture. An operator or trusted orchestrator registers the lead session and removes it after use; missing or unregistered sessions and events with an `agent_id` remain blocked. Other guard rules still apply. Protect this configuration from workers and use separate sessions: if a harness gives a worker the lead session ID without an `agent_id`, the guard cannot distinguish it from the lead. Do not grant capture on that harness without independent isolation. This is an operational trust boundary, not authentication.
- If the file is not valid JSON, the guard warns and falls back to the safe defaults: dependency adds stay blocked and no production pattern applies.

## Deny rules to set yourself

Add these to your harness's permission deny list. They hold even when the hook does not run: the hook is off, the event is unreadable, or a script does the work.

- Reading `**/.env`, `**/.env.*` (except templates), `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**` and `**/*.pem`.
- Writing outside the project folder and the system temp folder.
- `git push --force` and `git push -f`, plus pushing to `main` or `master`.
- `sudo`, plus any network command in the shell (`curl`, `wget`) if your work does not need one.

Each adapter's `MAPPING.md` gives the exact syntax for its harness.

## Known limits

The guard reads command text. Some things it cannot see:

- Code that runs from a file (`./cleanup.sh`, `make clean`, `npm run reset`) or inside an interpreter (`python -c "shutil.rmtree(...)"`, `node -e …`). The deny rules and the integrity check on the diff cover these.
- Shell aliases and functions.
- Recursive searches that happen to open a secret file (`grep -r TOKEN .`).
- Writes and edits to secret files through file tools. Those are allowed; only reads are blocked.

It also errs on the safe side in places:

- A `rm -r` on a path built from a variable is blocked even when the path would have been safe. Write the literal path instead.
- Text inside a heredoc is checked as if it were commands, so a heredoc that mentions a destructive command may be blocked.
- File tools are recognized by name (read, view, open, grep, search, cat). A file-read tool with another name is not checked for secrets.
- A harness that sends no command text to its hooks gets no shell rules. Such a harness relies on the deny rules alone, and its `MAPPING.md` says so. MendCode's native engine with Codex sends the full command; the harness matrix in the mend-autopilot repository records the measurement.
