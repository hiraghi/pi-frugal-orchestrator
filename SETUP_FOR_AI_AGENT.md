# Setup instructions for an AI agent

**Human:** clone this repo, then paste this whole file to your AI coding agent
(Pi itself, Claude Code, etc.) and say *"follow these setup instructions."*

**AI agent:** you are installing the **pi-frugal-orchestrator** system into the user's
Pi installation. Work through the steps below **interactively** — confirm with the user
at each decision point, never guess their model IDs. Be concise.

---

## 0. Locate paths

- `REPO` = the directory of this cloned repo (the folder containing this file,
  `agents/`, and `extensions/`).
- `PI_AGENT` = the user's Pi agent dir. Default `~/.pi/agent` (expand `~` via
  `$HOME` / `%USERPROFILE%`). Confirm it exists; if not, ask the user where Pi is
  installed.

## 1. Check requirements

Verify and report each; if anything is below the minimum, tell the user and stop:

- **Pi (`@earendil-works/pi-coding-agent`) `>= 0.74.0`** — check the user's Pi version.
- **Node `>= 22.19.0`** — run `node -v`.
- **`@tintinweb/pi-subagents` `>= 0.10.0`** — needed for the subagent `Agent` tool.
  Check whether it is already in the user's Pi packages.

## 2. Install the subagents package

If `@tintinweb/pi-subagents` (`>= 0.10.0`) is not already installed, **propose** adding
it to the user's Pi packages and let them approve. Use Pi's own package mechanism
(consult Pi's `docs/packages.md`); do not invent a command. Confirm success before
continuing.

## 3. Copy ONLY the needed files into `PI_AGENT`

Copy these, preserving the directory layout:

- `REPO/agents/*.md`        → `PI_AGENT/agents/`
- `REPO/extensions/*`       → `PI_AGENT/extensions/`

**Do NOT copy** any of: `.git/`, `.gitignore`, `LICENSE`, `README.md`, `README.ja.md`,
`SETUP_FOR_AI_AGENT.md`. (These are repo metadata, not part of the running system.)

If a target file already exists, show the user a diff and ask before overwriting —
especially `extensions/subagent-models.json` (it holds their model IDs; see step 4).

## 4. Configure model routing (interactive)

The file `PI_AGENT/extensions/subagent-models.json` ships with placeholder model IDs.
Replace them with model IDs that exist in **the user's Pi `models.json`**.

1. Read the user's `models.json` (or ask Pi which model IDs are available) and show the
   list to the user.
2. Ask the user to choose:
   - a cheap/fast **primary** model (ideally a local `llama.cpp`/`vLLM` model) →
     becomes `defaults[0]`.
   - an **overflow** model (a cheap cloud model is fine) → becomes `defaultOverflow`.
   - optionally a stronger **reasoning** model for the `planner` role override.
3. Write the chosen IDs into `subagent-models.json`, replacing `YOUR_LOCAL_MODEL`,
   `YOUR_REMOTE_MODEL`, `YOUR_CLOUD_MODEL`, `YOUR_REASONING_MODEL`. Remove the
   `_comment` / `_setup` helper keys if the user wants a clean file (they are ignored
   at runtime either way).
4. Show the final `subagent-models.json` and confirm it parses as valid JSON.

> Schema reminder: `defaults` is an ORDERED pool — the Nth concurrent spawn uses
> `defaults[N-1]`; spawns beyond the pool (or on spawn-error) use `defaultOverflow`.
> Sequential spawns use `defaults[0]`. Per-role overrides live under `roles` (an empty
> `{}` inherits the top-level pool).

## 5. Common rules file

Confirm `PI_AGENT/extensions/common-orchestrator.md` is present. The role commands load
and inject it automatically while a mode is active — the user does **not** need to paste
its contents into their `AGENTS.md`.

## 6. Finish

Tell the user to run **`/reload`** in Pi, then test with:

```
/research <a small question>
```

Expected: it enters research mode (the role prompt + common rules are injected) and the
orchestrator delegates to a `Researcher` subagent. `/orchestrator:exit` leaves the mode.

Report a short summary of what you installed, the model IDs you set, and anything the
user still needs to do.
