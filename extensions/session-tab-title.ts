// Set the Windows Terminal tab title to the user's first chat input, and KEEP
// it set across pi's own title resets.
//
// Why this is non-trivial:
//   pi core's interactive-mode calls updateTerminalTitle() (resetting the title
//   to the default "pi - cwd") on `session_info_changed` (a subagent setting a
//   session name) and after `/reload` (a fresh `session_start` reason:"reload").
//   In-memory state is also lost across /reload, so an in-memory-only re-apply
//   has nothing to restore.
//
// Fix:
//   - On the first real user prompt, set the title AND persist it via
//     pi.appendEntry() (survives /reload, resume, restart).
//   - On `session_start`, restore from the persisted entry; if none exists yet
//     (e.g. a session started before this code), fall back to deriving the
//     title from the first user message in the session history.
//   - On `agent_end`, re-assert the cached title (covers the subagent
//     session_info_changed reset mid-session).
//
// /research|/planner|/implementer|/tester are handled in subagent-models.ts,
// which sets+persists the title via the same shared flag (it persists too).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "session-tab-title";
const MAX_LEN = 50;

// Strip a leading slash-command / skill prefix so the *content* is shown.
const CMD_PREFIX = /^\/[\w-]+(?::[\w-]+)?\s*/;

// Orchestrator-style opening prompts embed the real intent after this marker
// (research/planner/... templates use "Top-level question:" / "Task:").
// Title from the question, not the boilerplate "You are the ... ORCHESTRATOR".
const QUESTION_MARKER = /(?:Top-level question|Task|Planning topic[^:]*|What to verify[^:]*|Plan file path[^:]*):\s*([\s\S]+)/i;

// Shared with subagent-models.ts via process global.
const _state = () =>
	((process as any).__piTabTitleState ??= { done: false }) as {
		done: boolean;
		title?: string;
	};

function clip(s: string): string {
	return s.length > MAX_LEN ? s.slice(0, MAX_LEN) + "…" : s;
}

function deriveTitle(raw: string): string | undefined {
	let t = (raw ?? "").trim();
	if (!t || t.startsWith("!")) return undefined; // bash / empty
	t = t.replace(CMD_PREFIX, "").trim(); // drop /command prefix
	const m = t.match(QUESTION_MARKER); // orchestrator prompt → use the question
	if (m && m[1].trim()) t = m[1].trim();
	return t ? clip(t) : undefined;
}

// Extract plain text from a message.content that may be a string or an array.
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((p: any) => (typeof p === "string" ? p : (p?.text ?? "")))
			.join(" ")
			.trim();
	}
	return "";
}

function apply(ctx: any, title: string): void {
	if (!ctx?.hasUI) return;
	ctx.ui.setTitle(title);
	const s = _state();
	s.title = title;
	s.done = true;
}

// Restore the title using the CURRENT BRANCH (getBranch, leaf→root), not
// getEntries() (which returns ALL entries across ALL branches in insertion
// order — that is why a mid-conversation message was picked before).
// Order: 1) the persisted clean title (role commands); 2) the session's
// OPENING user prompt = the earliest user message on the branch.
function restoreFromSession(ctx: any): string | undefined {
	let branch: any[];
	try {
		branch = ctx.sessionManager.getBranch() ?? [];
	} catch {
		return undefined;
	}
	const persisted = branch
		.filter((e) => e?.type === "custom" && e?.customType === ENTRY_TYPE)
		.pop();
	if (persisted?.data?.title) return persisted.data.title as string;

	// Earliest user message = the opening prompt (sort by timestamp so the
	// leaf→root vs root→leaf order of getBranch doesn't matter).
	const users = branch
		.filter((e) => e?.type === "message" && e?.message?.role === "user")
		.sort((a, b) =>
			String(a?.timestamp ?? "").localeCompare(String(b?.timestamp ?? "")),
		);
	for (const u of users) {
		const t = deriveTitle(messageText(u.message.content));
		if (t) return t;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		if (!ctx.hasUI) return { action: "continue" };
		// Ignore extension-injected messages (e.g. /research orchestrator prompt).
		if (event.source === "extension") return { action: "continue" };

		const s = _state();
		if (s.done) {
			if (s.title) apply(ctx, s.title); // keep it asserted
			return { action: "continue" };
		}

		const title = deriveTitle(event.text ?? "");
		if (!title) return { action: "continue" }; // bash/empty/bare command

		apply(ctx, title);
		try {
			pi.appendEntry(ENTRY_TYPE, { title });
		} catch {
			/* persistence best-effort */
		}
		return { action: "continue" };
	});

	// pi core resets the title to default after /reload, /resume, etc. Restore.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const title = restoreFromSession(ctx);
		if (title) apply(ctx, title);
	});

	// pi core also resets via session_info_changed when a subagent names a
	// session; re-assert after the parent run completes.
	pi.on("agent_end", async (_event, ctx) => {
		const s = _state();
		if (s.title) apply(ctx, s.title);
	});
}
