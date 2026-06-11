*Languages: **English** · [日本語](README.ja.md)*

# pi-frugal-orchestrator

A **token-frugal orchestration layer** for the [Pi coding agent](https://github.com/earendil-works/pi).
The expensive main model acts as an **orchestrator** — it issues instructions and
judges results — and each task is assigned to the most cost-effective actor (a **hybrid**
model, not all-cheap-subagents): a frontier main writes plans itself, a mid-tier main
implements directly, and cheap / local subagents handle research, lookups, and verification.

> Philosophy: keep the costly model's context lean. Assign every task to the cheapest actor that can do it well.

## Why this works

| Benefit | How |
|---|---|
| **Best of both worlds** | A high-accuracy main model (Claude Opus, GPT Codex, etc.) makes smart decisions and handles work that needs frontier quality (e.g. writing the plan), while cheap subagent models do the parallel heavy lifting (research, lookups, verification). |
| **Light main-model context** | The orchestrator only receives subagents' final outputs (capped at ~50 KB). It never sees raw search results, full file dumps, or intermediate diffs — so input and output tokens stay small. |
| **Fair, unbiased verification** | The verifier subagent works in a clean context separate from the implementer. The orchestrator judges results without the "testing your own work" bias that accumulates in a single long context. |
| **Subagents outperform standalone** | Lightweight models alone tend to give up early or miss the right path. Guided by precise prompts from the orchestrator, they reliably reach the information you need. The subagent harness also lets models that would normally stop halfway keep working for extended sessions. |

## How it works

Four role slash-commands each spawn a specialized subagent and inject a role-specific
orchestrator prompt, with model routing pulled from a single config file:

| Command | Role | Subagent |
|---|---|---|
| `/research` | read-only investigation | `Researcher` |
| `/planner` | writes an implementation plan FILE | **main writes it directly** + `Researcher` (read-only checker) |
| `/implementer` | implements a plan | **mid-tier main implements directly** + `Researcher` (lookups) + `verifier` (final DoD judgment) |
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

**Model selection guideline:**
- **If you have a local LLM**: set it as the primary `defaults[0]`.
  It runs for free and handles most subagent work. Use a cloud model for `defaultOverflow`
  (parallel overflow or error fallback).
- **No local LLM**: it is fine to use the same cheap cloud model (e.g. DeepSeek V4 Flash,
  Mimo) for both `defaults` and `defaultOverflow`. The system still saves main-model tokens
  by delegating work — the routing logic is the same.
- **Per-role overrides** (e.g. `planner` → larger-window model) are optional but recommended
  when a role benefits from a specific model's strengths.

## Typical Workflow

```
Session 1
  Start → /research <what you want>
    → Main model spawns Researcher subagents (local/cloud models)
    → Subagents work for 5-20 min, return results (≤50 KB each)
    → Main model summarizes → you ask questions → refine design
    → Design is solid → /planner → saves plan file
  (Optional) /new to reset accumulated context
                              ↓
Session 2 (clean context)
  (Switch to a mid-tier model via /model before /implementer)
  /implementer <plan file>
    → Main model reads plan → fills gaps via Researcher (lookups only)
    → Main model writes the code itself (no delegation)
    → Spawns verifier subagent (read-only) → checks DoD
    → FAIL → main model fixes → re-verify (loop until PASS)
    → Done → /tester for independent final verification
```

**Why split sessions?** Session 1 accumulates research context. Starting fresh for
implementation gives the orchestrator a clean slate — it re-reads the plan file at full
price once, but the small plan file is cheap to re-cache, and the clean context prevents
research debris from polluting implementation decisions.

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
   with model IDs that exist in your Pi `models.json` or `models.generated.js`.
4. Keep `extensions/common-orchestrator.md` in your extensions dir — the role commands
   load and inject it automatically while a mode is active (no need to paste it into
   `AGENTS.md`).
5. `/reload` Pi (extensions and prompts are loaded at startup).

## Files

```
agents/            # subagent definitions — Researcher & verifier are spawned by the role flows;
                   #   planner.md / implementer.md are legacy (the main model now writes/implements directly)
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
