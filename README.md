*Languages: **English** · [日本語](README.ja.md)*

# pi-frugal-orchestrator

A **token-frugal orchestration layer** for the [Pi coding agent](https://github.com/earendil-works/pi).
The expensive main model acts purely as an **orchestrator** — it issues instructions and
judges results — while the actual work tokens (research, planning, implementation, testing)
are delegated to cheap / local subagent models via role commands.

> Philosophy: keep the costly model's context lean. Direct, don't do.

## How it works

Four role slash-commands each spawn a specialized subagent and inject a role-specific
orchestrator prompt, with model routing pulled from a single config file:

| Command | Role | Subagent |
|---|---|---|
| `/research` | read-only investigation | `Researcher` |
| `/planner` | writes an implementation plan FILE | `planner` (writer) + `Researcher` (checker) |
| `/implementer` | implements a plan, self-verifies | `implementer` + `Researcher` |
| `/tester` | re-runs the plan's Definition-of-Done checks | `verifier` |

Each command **enters a persistent role mode**. `/research <task>` in one step delivers
the role context + your task as the kickoff message and starts work; every following
turn re-injects the role prompt + the shared rules in `common-orchestrator.md` + the
model-routing block at the *end* of the system prompt (so the cacheable prefix is
preserved). Run `/orchestrator:exit` to leave the mode (mode also clears on `/reload`).
Outside any mode, nothing is injected — so the orchestrator rules cost zero context
when unused.

Model routing is centralized in **`extensions/subagent-models.json`**: an ordered
`defaults` pool (the Nth concurrent spawn uses `defaults[N-1]`), a `defaultOverflow`
model for spawns beyond the pool or on spawn-error, and per-role overrides.

## Requirements

- **Pi (`@earendil-works/pi-coding-agent`) `>= 0.74.0`**
- **`@tintinweb/pi-subagents` `>= 0.10.0`** (provides the subagent `Agent` tool the
  role commands rely on)
- **Node `>= 22.19.0`**
- At least one model provider configured in your Pi `models.json` (e.g. a local
  `llama.cpp` / `vLLM` server for the cheap workers, plus an optional cloud model for
  overflow).

## Install

### Option A — let an AI agent set it up for you (recommended)

Clone this repo, then hand the file [`SETUP_FOR_AI_AGENT.md`](SETUP_FOR_AI_AGENT.md) to
your AI coding agent (Pi itself, Claude, etc.). It walks the agent through checking
requirements, installing `@tintinweb/pi-subagents`, copying only the needed files into
`~/.pi/agent/`, and interactively filling in your model IDs in `subagent-models.json`.

### Option B — manual

1. Copy ONLY the agent files into your Pi agent directory (do **not** copy `.git/`,
   `.gitignore`, `LICENSE`, `README*.md`, or `SETUP_FOR_AI_AGENT.md`):
   - `agents/*.md` → `~/.pi/agent/agents/`
   - `extensions/*` → `~/.pi/agent/extensions/`
2. Install the subagents package into Pi: add `@tintinweb/pi-subagents` to your Pi
   packages (see Pi's package docs), so the `Agent` tool is available.
3. Edit `~/.pi/agent/extensions/subagent-models.json` and replace the placeholder model
   IDs (`YOUR_LOCAL_MODEL`, `YOUR_REMOTE_MODEL`, `YOUR_CLOUD_MODEL`, `YOUR_REASONING_MODEL`)
   with model IDs that exist in your Pi `models.json`.
4. Keep `extensions/common-orchestrator.md` in your extensions dir — the role commands
   load and inject it automatically while a mode is active (no need to paste it into
   `AGENTS.md`).
5. `/reload` Pi (extensions and prompts are loaded at startup).

## Files

```
agents/            # subagent definitions (Researcher, planner, implementer, verifier)
extensions/
  subagent-models.ts          # model-routing logic + role command registration
  subagent-models.json        # model routing config (edit placeholders)
  common-orchestrator.md      # shared orchestrator rules
  research-orchestrator.md    # /research prompt
  planner-orchestrator.md     # /planner prompt
  implementer-orchestrator.md # /implementer prompt
  tester-orchestrator.md      # /tester prompt
  session-tab-title.ts        # UI: per-session tab titles
  subagent-context-watchdog.ts# wraps up subagents nearing context limits
```

## License

MIT © [hiraghi](https://github.com/hiraghi) — see [LICENSE](LICENSE).
