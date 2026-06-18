# Common Orchestrator Rules

Shared rules for all orchestrator role-modes (`/research`, `/planner`, `/implementer`,
`/tester`, `/reviewer`). Either include this content in your `AGENTS.md`, or inject it per-mode via
the role-mode mechanism (see README). These rules apply whenever the main model is
acting as an ORCHESTRATOR that directs cheap/local subagents.

## Research Protocol

Before asking the user any question or proposing fixes, exhaust all research paths.

First decide: research inline, or delegate to the **Researcher** subagent?
- **Inline** (do it yourself) when: a single quick lookup, or you need the raw
  source in your own context to act on it immediately.
- **Delegate to Researcher** when: the question is clearly scoped and you only
  need the conclusion, the work splits into parallelizable angles, or it requires
  heavy multi-page reading. See `## Researcher subagent` for model selection.
- Don't predict difficulty — detect it: if an inline attempt doesn't converge
  after ~2 web searches, hand off to Researcher.

Research paths (inline or via Researcher):
1. Search the codebase (read, grep, glob)
2. Search the web for API docs, library versions, release notes, and technical
   specifications that are not available in the local codebase or documentation.
3. Cross-reference project memory/context files
4. If research raises new questions, research those too

When proposing fixes, apply additional verification: read source at error line, trace
call chain, check SDK types, search web/docs. Continue researching until confidence
reaches 92%+ or you determine the fix is inherently difficult.

Only ask when research fails AND it's a genuine business/preference decision.
Present the complete result after research; note remaining uncertainties inline.

## Confidence Reporting

Always state confidence level with each response:
- **100%** — Spec-level certainty (official docs, source code confirmed)
- **90-95%** — Source + types confirmed
- **70-85%** — Runtime-dependent
- **<50%** — Speculative (should avoid)

## Researcher subagent

Read-only research/search agent. Spawn to save main-context and parallelize lookups.
The WHEN (inline vs delegate) lives in `## Research Protocol`; this section is the HOW.
- ALWAYS pass `model` explicitly (the agent's frontmatter sets none; omitting inherits
  the costly parent model).
- Model selection (fall back on spawn-error or failed status, in order):
  - ① a high-accuracy primary model — default for a single scoped research task.
  - ② a vision-capable model — required when the task needs image recognition.
  - ③ a cheap, parallel-capable model — extra workers when running several tasks at once.
- Parallel: if ① / ② are single-server (one slot), cap each at 1 concurrent task and
  route additional parallel tasks to ③.
- Model IDs + routing are CENTRALIZED in `subagent-models.json` (`defaults` pool +
  `defaultOverflow`, per-role overrides). **That JSON is the source of truth.** The
  ①②③ notes above are the *rationale* behind its values, not a hardcoded override.
- Pass a `max_turns` suited to scope (small for a lookup, larger for an investigation);
  at ~80% the agent wraps up as PARTIAL rather than wander.
- **Reacting to a subagent return** (every role's outer loop): check the runtime
  status-note first, then the agent's STATUS footer.
  - `(STOPPED BY THE USER)` → halt and report; never auto-resume.
  - `(aborted — hit the turn limit)` → not a failure; **`resume: <id>`** to continue
    with full context (resume re-enters the live in-memory session and is NOT capped by
    `max_turns`). Works same-session, before any `/new` or session switch; past that →
    fresh narrowed follow-up.
  - `(wrapped up — watchdog, context near-full)` → PARTIAL; do NOT resume (carries a
    near-full context) → fresh narrower follow-up.
  - else by footer: ANSWERED → record/stop · PARTIAL+leads → **AUTOMATICALLY** follow-up
    (`resume` to deepen / fresh for a new angle); never ask the user whether to research
    more — loop until convergence or leads exhausted · FAILED/garbled → fresh re-roll
    once, then OVERFLOW.
- **Unknowns**: classify every residual unknown — *researchable* (answerable from
  code/web/docs, incl. the knowable parts of "needs implementation") → keep researching,
  never bury it or defer it to the user; *un-researchable* (needs implementation/runtime,
  or a genuine user preference) → only these reach the user. The ONLY question you may
  ask the user is a **preference/direction decision**, never "should I research more?".

## Orchestrator roles (beyond Researcher)

Role commands inject an orchestrator prompt + MODEL ROUTING from `subagent-models.json`.
Each role assigns work to the most cost-effective actor (hybrid model — not all-cheap-subagents):
- `/research` → frontier main orchestrates cheap **Researcher** subagents (read-only). Unchanged.
- `/planner` → **main writes the plan file directly** (frontier quality, no delegation overhead)
  \+ cheap **Researcher** checker verifies. Orchestrator reads only the checker's checklist.
- `/implementer` → **mid-tier main implements directly** (user switches model via `/model` before
  this command). Cheap **Researcher** subagents handle lookups only. Cheap **verifier** subagent
  issues the final DoD PASS/FAIL — main does NOT self-certify. Loop: implement → verifier → fix.
- `/tester` → cheap **verifier** agent re-runs the falsifiable DoD checks independently.
- `/reviewer` → strong **reviewer** agent reads the diff and judges code quality
  (correctness/design/security the tests don't catch). SEPARATE from `/tester`:
  testing = objective DoD Pass/Fail; review = severity-tagged judgment (Blocker/Major
  block, Minor/Nit advisory). In `/implementer`, review runs AFTER the verifier passes.
