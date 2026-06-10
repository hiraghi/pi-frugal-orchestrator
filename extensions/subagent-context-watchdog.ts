// subagent-context-watchdog.ts
//
// Makes read-only research subagents (default: "Researcher") WRAP UP with a
// PARTIAL status BEFORE their context window fills up and triggers lossy
// automatic compaction — and bounds the "infinite compaction loop" failure mode.
//
// WHY an extension (not just a prompt):
//   A prompt instruction cannot make the model reliably know its own context
//   fill %. The harness, however, exposes ctx.getContextUsage() and lets an
//   extension inject a steer message — exactly how @tintinweb/pi-subagents
//   enforces max_turns (it calls session.steer() from a turn_end handler).
//   This watchdog is the *context* analogue of that *turn* mechanism.
//
// MECHANISM (verified against @earendil-works/pi-coding-agent types.d.ts):
//   - turn_end       → read ctx.getContextUsage(); if we're within SAFETY tokens
//                      of the compaction trigger (contextWindow - RESERVE_TOKENS),
//                      steer the agent to finalize NOW with STATUS: PARTIAL.
//                      Firing on a TOKEN budget (not a flat %) keeps it correct
//                      across context windows of any size.
//   - session_compact→ count compactions. 1st: steer "you compacted, finalize".
//                      2nd: ctx.abort() — hard backstop so a degenerate
//                      compact→regrow→compact loop cannot run forever.
//
// SCOPING:
//   Acts ONLY in headless subagent sessions (ctx.hasUI === false) whose session
//   name matches WATCHED_AGENTS. The interactive main session (hasUI === true)
//   is never touched, and unrelated subagents (implementer/general-purpose) are
//   left alone so their legitimate long runs aren't cut short.
//
// All APIs used are confirmed present in:
//   dist/core/extensions/types.d.ts
//     ContextUsage { tokens, contextWindow, percent }      L192-198
//     ExtensionContext.hasUI / getContextUsage / abort     L211 / L231 / L219
//     ExtensionContext.sessionManager.getSessionName()     (ReadonlySessionManager)
//     SessionCompactEvent  (pi.on "session_compact")       L410 / L791
//     ExtensionAPI.sendUserMessage(text,{deliverAs:"steer"})L843

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** Session-name prefixes this watchdog applies to (matched before the "#id").
 * Only READ-ONLY agents that emit a STATUS footer belong here. planner /
 * implementer are intentionally excluded: they produce artifacts and must not
 * be cut off mid-write. */
const WATCHED_AGENTS = ["Researcher", "verifier"];

/**
 * pi's default compaction reserve. Auto-compaction fires when
 *   tokens > contextWindow - RESERVE_TOKENS
 * (see @earendil-works compaction.js DEFAULT_COMPACTION_SETTINGS.reserveTokens).
 */
const RESERVE_TOKENS = 16384;

/**
 * Steer this many tokens BEFORE compaction would trigger, so the agent gets a
 * clean final turn while its findings are still intact. ~12k ≈ one full turn of
 * headroom. Effective steer point = contextWindow - RESERVE_TOKENS - SAFETY.
 *   128k window → steer ≈ 78% | 200k window → steer ≈ 86%  (both below compaction)
 */
const SAFETY_TOKENS = 12000;

/** Fallback when token count is unavailable (e.g. right after a compaction). */
const FALLBACK_PERCENT = 78;

/** After this many compactions in one run, hard-abort (loop backstop). */
const MAX_COMPACTIONS = 2;

// ─── Messages ────────────────────────────────────────────────────────────────

const STEER_NEAR_FULL =
	"⚠ CONTEXT BUDGET NEARLY FULL. Stop researching NOW — do not start new " +
	"searches, do not open more files. Using ONLY what you have already gathered, " +
	"write your FINAL answer immediately and end with your STATUS footer marked " +
	"PARTIAL (or ANSWERED only if the question is genuinely fully resolved), with " +
	"STILL_UNKNOWN / NEW_LEADS filled in. Finishing now prevents lossy context " +
	"compaction that would destroy your findings.";

const STEER_AFTER_COMPACTION =
	"⚠ YOUR CONTEXT WAS JUST COMPACTED — earlier findings may be partially lost. " +
	"Do NOT continue researching. Immediately output your FINAL answer from what " +
	"remains in your notes and end with STATUS: PARTIAL (fill STILL_UNKNOWN / " +
	"NEW_LEADS). Do not trigger another compaction.";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isWatchedSubagent(ctx: ExtensionContext): boolean {
	// Scope by session name: the runner names subagent sessions after the agent
	// config (e.g. "Researcher#1a2b3c4d"). The interactive main session is named
	// after the cwd/label and never starts with a watched agent name, so this
	// alone correctly excludes it. (hasUI is intentionally NOT required — relying
	// on it risks a false-negative if a headless subagent ever reports hasUI.)
	const name = ctx.sessionManager.getSessionName?.() ?? "";
	return WATCHED_AGENTS.some((a) => name.startsWith(a));
}

function nearCompaction(ctx: ExtensionContext): boolean {
	const u = ctx.getContextUsage?.();
	if (!u) return false;
	if (u.tokens != null && u.contextWindow > 0) {
		return u.tokens > u.contextWindow - RESERVE_TOKENS - SAFETY_TOKENS;
	}
	if (u.percent != null) return u.percent >= FALLBACK_PERCENT;
	return false;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Per-session state (a fresh extension runtime is bound per subagent session,
	// but reset on session_start defensively).
	let nearFullSteered = false;
	let compactions = 0;

	pi.on("session_start", async () => {
		nearFullSteered = false;
		compactions = 0;
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!isWatchedSubagent(ctx)) return;
		if (nearFullSteered) return;
		if (nearCompaction(ctx)) {
			nearFullSteered = true;
			pi.sendUserMessage(STEER_NEAR_FULL, { deliverAs: "steer" });
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (!isWatchedSubagent(ctx)) return;
		compactions++;
		// Allow the near-full steer to fire again as context regrows post-compaction.
		nearFullSteered = false;
		if (compactions >= MAX_COMPACTIONS) {
			// Degenerate compact→regrow→compact loop: stop it. The runner returns
			// the last assistant text to the parent, which should carry PARTIAL.
			ctx.abort();
		} else {
			pi.sendUserMessage(STEER_AFTER_COMPACTION, { deliverAs: "steer" });
		}
	});
}
