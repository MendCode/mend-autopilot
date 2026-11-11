# mend-autopilot

> mend-autopilot turns small tasks into pull requests written by a cheap model and checked by a strong one, each with the evidence to merge it. This file installs its MendCode package and prepares one project.

I want you to install mend-autopilot and set up my project. Follow the steps below in order, and stop where a step tells you to stop.

OBJECTIVE: Install the mend-autopilot package that matches the user's subscription and prepare the project they confirm.

DONE WHEN:

- `mendcode package list --json` lists `mend-autopilot-<harness>` as installed and enabled
- on a Claude subscription, `claude plugin list` shows `mend-autopilot@mend-autopilot-local` enabled
- the project the user confirmed ignores `.mend/` in git
- the user has been told to run `/mend-setup` in a MendCode session, and on which model

TODO:

- [ ] Check MendCode, Node, Python and git
- [ ] Pick the package for the user's subscription
- [ ] Get the source, build the package and install it, with the user's confirmation
- [ ] Prepare the project the user confirms
- [ ] Report what was installed and the next command

Never change the user's models, permission mode, trust settings or tier: mend-autopilot ships recipes for those, and applying one is always the user's step. Never edit shell startup files, never use sudo, and never push or merge anything.

## 1. Requirements

Run `mendcode --version`, `node --version`, `python3 --version` and `git --version`.

- **MendCode missing:** mend-autopilot is a set of MendCode packages and does nothing without it. Show the installer for the user's OS and run it only once they confirm:

  ```bash
  # macOS / Linux
  curl -fsSL https://github.com/MendCode/MendCode/releases/latest/download/install.sh | sh
  ```

  ```powershell
  # Windows (PowerShell)
  irm https://github.com/MendCode/MendCode/releases/latest/download/install.ps1 | iex
  ```

  If `mendcode` is still not found afterwards, relay the last line the installer printed (it names the folder to add to `PATH`) and stop until the user confirms it works in a new shell.
- **Node older than 20, Python older than 3.9, or git missing:** don't install or switch versions yourself. Say which one is missing and stop.

## 2. Pick the package

There is one package per subscription. Lead with your best guess instead of an open question: if you are running inside Claude Code, the user most likely has a Claude plan; inside Codex or ChatGPT, a ChatGPT plan. Name the one you picked and let them correct it.

| Subscription | Harness id | Cheap model writes the code | Strong model reviews |
|---|---|---|---|
| ChatGPT | `codex` | gpt-6-luna or gpt-6.1-terra | gpt-6-astra |
| Claude Pro or Max | `claude` | claude-haiku or claude-sonnet | claude-opus |
| OpenCode Go | `opencode-go` | deepseek-v4.1-flash | gemini-4-carbon or gemini-4-argon |

Say plainly that the ChatGPT package is the one that has been used end to end; the Claude and OpenCode Go packages pass every offline check but have not yet run with their models. A user may install more than one; repeat steps 3 and 4 for each.

## 3. Get the source and build

The package is built from this repository; the build has no dependencies and writes only to the repository's `dist/` folder.

Propose `~/.local/share/mend-autopilot` as the folder for the source and let the user pick another. If that folder already holds a clone of `https://github.com/MendCode/mend-autopilot`, update it with `git pull --ff-only` instead of cloning again; if the pull refuses because of local changes, stop and say so rather than discarding them. If the folder exists and holds something else, stop and ask.

```bash
git clone https://github.com/MendCode/mend-autopilot ~/.local/share/mend-autopilot
cd ~/.local/share/mend-autopilot
node build.mjs <harness>
```

A build that exits with anything other than 0 writes nothing; relay its message and stop.

## 4. Install

Run `mendcode package list --json` first. If `mend-autopilot-<harness>` is already installed, say so and offer to replace it with the new build (`--replace`); otherwise install it. Show the exact command and run it once the user confirms:

```bash
mendcode package install "$HOME/.local/share/mend-autopilot/dist/mend-autopilot-<harness>"
```

Use the absolute path of the source folder from step 3, not `~`.

**Claude only.** Sessions on Claude models run on the Claude Code engine, which loads Claude Code's skills and hooks, not MendCode's, so the Claude package is also a Claude Code plugin. Its guard acts only inside repositories that have a `.mend/` folder. Installing it changes the user's Claude Code configuration, so show both commands and run them only once the user confirms:

```bash
claude plugin marketplace add "$HOME/.local/share/mend-autopilot/dist/mend-autopilot-claude"
claude plugin install mend-autopilot@mend-autopilot-local
```

Tell the user it can be turned off at any time with `claude plugin disable mend-autopilot@mend-autopilot-local`.

**OpenCode Go only.** The models are reached through MendCode's native `opencode-go` provider. Don't ask for, read or store an API key yourself; tell the user to run `mendcode providers login --provider opencode-go` themselves (and `--provider opencode` for Gemini Carbon). `/mend-setup` checks that the account can reach each model.

## 5. Prepare the project

Work out which project to prepare and lead with your best guess: the version control root of the folder the user is working in. Name it and let them correct it. If it is a home directory, a temp directory or holds no project, stop and ask where the project is.

- Add `.mend/` to the project's `.gitignore` if it is not there yet. Show the line and add it once the user confirms. mend-autopilot keeps its items, worktrees and evidence cards in `.mend/`; none of it belongs in the project's history.
- If the project has no verification skill (a skill under `.mendcode/skills/` that lists the commands proving the project works), say that the workflows need one and that the `create-verification` skill writes it in the user's first session. Don't write one now.

## 6. Report

Relay what actually happened: the package name and version that `mendcode package list --json` now shows, whether the Claude plugin is enabled, and whether `.gitignore` changed.

Finish with the next step, which is the user's:

1. Open a MendCode session on a model of their subscription: a ChatGPT model for `codex`, a Claude model for `claude`, an OpenCode Go model for `opencode-go`.
2. Run `/mend-setup`. It changes nothing: it checks the engine, the tools and the install, proves the guard blocks a probe, and prints the recipe for their plan and the safety steps for them to apply.
3. Describe a first item in `.mend/items/<id>.json` and run the `mend-lite` and `mend-lite-pr` workflows, as the [README](https://github.com/MendCode/mend-autopilot#quick-start) shows.
