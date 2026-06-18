// Role-command + per-session model selection for orchestrator/subagent flows.
//
// Generalizes the old single-role `research-model.ts` into a ROLE TABLE so one
// extension + one config file (`subagent-models.json`) drive every role:
//
//   /research <q>      orchestrate the Researcher subagent
//   /planner <topic>   orchestrate Planner (writer) + checker subagents
//   /implementer <p>   orchestrate implementer + verifier/reviewer subagents
//   /tester <p>        orchestrate the verifier subagent (independent checks)
//   /reviewer <p>      orchestrate the reviewer subagent (independent code review)
//
//   /<role>            (no args) → show this role's session model settings
//   /<role>:models     pick the PRIMARY model (= DEFAULTS[0]) for this role+session
//   /<role>:overflow   pick the OVERFLOW model (or none) for this role+session
//
// MODEL ROUTING semantics (user spec):
//   `defaults` is an ORDERED pool. The Nth spawn running CONCURRENTLY uses
//   defaults[N-1]; once concurrency exceeds defaults.length, extra concurrent
//   spawns use `defaultOverflow`. Sequential spawns use defaults[0].
//
// Verified APIs (see research-model.ts header / package .d.ts):
//   registerCommand(name,{description,handler})   handler:(args,ctx)=>Promise<void>
//   ctx.ui.select / ui.notify ;  pi.sendUserMessage(content)
//   ctx.modelRegistry.getAvailable() ; ctx.sessionManager.getSessionId()

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Paths ──────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
	const h = process.env.HOME || process.env.USERPROFILE || "";
	return p.startsWith("~/") ? path.join(h, p.slice(2)) : p;
}

const EXT_DIR = expandHome("~/.pi/agent/extensions");
const CONFIG_PATH = path.join(EXT_DIR, "subagent-models.json");
const LEGACY_CONFIG_PATH = path.join(EXT_DIR, "research-models.json");

// ─── Role table ───────────────────────────────────────────────────────────────

interface Role {
	key: string; // command name + config key: "research"
	agent: string; // subagent_type to spawn: "Researcher"
	verb: string; // UI label: "Research"
	orchestrator: string; // orchestrator prompt file in EXT_DIR
}

const ROLES: Role[] = [
	{
		key: "research",
		agent: "Researcher",
		verb: "Research",
		orchestrator: "research-orchestrator.md",
	},
	{
		key: "planner",
		agent: "planner",
		verb: "Plan",
		orchestrator: "planner-orchestrator.md",
	},
	{
		key: "implementer",
		agent: "implementer",
		verb: "Implement",
		orchestrator: "implementer-orchestrator.md",
	},
	{
		key: "tester",
		agent: "verifier",
		verb: "Test",
		orchestrator: "tester-orchestrator.md",
	},
	{
		key: "reviewer",
		agent: "reviewer",
		verb: "Review",
		orchestrator: "reviewer-orchestrator.md",
	},
];

// ─── Config ─────────────────────────────────────────────────────────────────

interface RoleConfig {
	models?: string[];
	defaults?: string[];
	default?: string; // legacy single primary
	defaultOverflow?: string | null;
}

interface SubagentModelsConfig {
	models: string[];
	defaults?: string[];
	default?: string; // legacy single primary
	defaultOverflow?: string | null;
	roles?: Record<string, RoleConfig>;
}

const DEFAULT_CONFIG: SubagentModelsConfig = {
	models: [
		"local-llm/YOUR_LOCAL_MODEL",
		"remote-llm/YOUR_REMOTE_MODEL",
		"opencode-go/YOUR_CLOUD_MODEL",
	],
	defaults: ["local-llm/YOUR_LOCAL_MODEL"],
	defaultOverflow: "opencode-go/YOUR_CLOUD_MODEL",
};

function readJson(p: string): SubagentModelsConfig | null {
	try {
		if (fs.existsSync(p)) {
			const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
			if (Array.isArray(parsed.models) && parsed.models.length > 0) {
				return parsed as SubagentModelsConfig;
			}
		}
	} catch {
		/* ignore */
	}
	return null;
}

function loadConfig(): SubagentModelsConfig {
	return readJson(CONFIG_PATH) ?? readJson(LEGACY_CONFIG_PATH) ?? DEFAULT_CONFIG;
}

/** Does this role explicitly configure its own PRIMARY model pool? */
function roleHasPrimaryConfig(cfg: SubagentModelsConfig, roleKey: string): boolean {
	const rc = cfg.roles?.[roleKey];
	if (!rc) return false;
	return (Array.isArray(rc.defaults) && rc.defaults.length > 0) || typeof rc.default === "string";
}

/** Does this role explicitly configure its own OVERFLOW model? */
function roleHasOverflowConfig(cfg: SubagentModelsConfig, roleKey: string): boolean {
	const rc = cfg.roles?.[roleKey];
	return !!rc && rc.defaultOverflow !== undefined;
}

/** Resolved (role-merged) pool + overflow + catalog. */
interface Resolved {
	catalog: string[];
	defaults: string[]; // ordered pool, length ≥ 1
	overflow: string | null;
}

function toPool(
	defaults: string[] | undefined,
	single: string | undefined,
): string[] | undefined {
	if (Array.isArray(defaults) && defaults.length > 0) return defaults;
	if (single) return [single];
	return undefined;
}

function resolveRole(cfg: SubagentModelsConfig, roleKey: string): Resolved {
	const rc = cfg.roles?.[roleKey] ?? {};
	const catalog = rc.models ?? cfg.models;
	const defaults =
		toPool(rc.defaults, rc.default) ??
		toPool(cfg.defaults, cfg.default) ??
		[catalog[0]];
	const overflow =
		rc.defaultOverflow !== undefined
			? rc.defaultOverflow
			: cfg.defaultOverflow !== undefined
				? cfg.defaultOverflow
				: null;
	return { catalog, defaults, overflow };
}

// ─── Per-session, per-role state ──────────────────────────────────────────────

interface SessionState {
	/** Overrides DEFAULTS[0] (the primary) when set. */
	primary?: string;
	/** Overflow override: string, null = "serialize on primary", undefined = config. */
	overflow?: string | null;
}

const SESSIONS = new Map<string, SessionState>();

function stateFor(ctx: ExtensionCommandContext, roleKey: string): SessionState {
	const id = `${ctx.sessionManager.getSessionId()}::${roleKey}`;
	let s = SESSIONS.get(id);
	if (!s) {
		s = {};
		SESSIONS.set(id, s);
	}
	return s;
}

function effectiveDefaults(state: SessionState, r: Resolved): string[] {
	if (!state.primary) return r.defaults;
	return [state.primary, ...r.defaults.slice(1)];
}

function effectiveOverflow(state: SessionState, r: Resolved): string | null {
	return state.overflow !== undefined ? state.overflow : r.overflow;
}

// ─── Model choices ─────────────────────────────────────────────────────────────

interface Choice {
	id: string;
	label: string;
}

const NONE_LABEL = "⛔ none — serialize all spawns on the primary model";

function buildModelChoices(r: Resolved, ctx: ExtensionCommandContext): Choice[] {
	const available = ctx.modelRegistry.getAvailable();
	const availIds = new Set(available.map((m) => `${m.provider}/${m.id}`));
	const nameById = new Map(
		available.map((m) => [`${m.provider}/${m.id}`, m.name ?? m.id]),
	);
	const source = r.catalog;
	const known = source.filter((id) => availIds.has(id) || nameById.has(id));

	if (source.length > 0 && known.length > 0) {
		return source.map((id) => {
			const nm = nameById.get(id);
			const marker = availIds.has(id) ? "" : "  ⚠ no API key";
			const label = nm ? `${nm}  [${id}]${marker}` : `${id}${marker}`;
			return { id, label };
		});
	}
	return available
		.map((m) => ({
			id: `${m.provider}/${m.id}`,
			label: `${m.name ?? m.id}  [${m.provider}/${m.id}]`,
		}))
		.sort((a, b) => a.label.localeCompare(b.label));
}

// ─── Orchestrator message assembly ─────────────────────────────────────────────

function loadOrchestratorBody(role: Role): string {
	try {
		return fs.readFileSync(path.join(EXT_DIR, role.orchestrator), "utf-8").trim();
	} catch {
		return (
			`You are the ${role.verb.toUpperCase()} ORCHESTRATOR. Spawn the ` +
			`**${role.agent}** subagent(s), judge their results, decide whether to ` +
			`spawn again, then synthesize the final answer.\n\n` +
			"Task: {{QUESTION}}\n\n" +
			`Spawn: \`Agent({ subagent_type: "${role.agent}", model: <see MODEL ` +
			"ROUTING>, prompt: <full task + context>, description: <3-5 words> })`"
		);
	}
}

function buildRoutingBlock(defaults: string[], overflow: string | null): string {
	const n = defaults.length;
	const lines = [
		"\n\n---\n\n## MODEL ROUTING (authoritative — overrides any model hints above)",
	];
	if (n === 1) {
		lines.push(
			`- **PRIMARY** model — use for the main run and for sequential spawns: \`${defaults[0]}\``,
		);
	} else {
		lines.push(
			`- **DEFAULTS pool** — assign CONCURRENT spawns to these models IN ORDER, one per concurrent spawn:`,
		);
		defaults.forEach((m, i) => lines.push(`  ${i + 1}. \`${m}\``));
		lines.push(
			`- Up to ${n} spawns running AT ONCE use the DEFAULTS pool (concurrent spawn #k → pool model #k).`,
			`- SEQUENTIAL spawns (one at a time) → always use DEFAULTS[0]: \`${defaults[0]}\`.`,
		);
	}
	if (overflow && !defaults.includes(overflow)) {
		lines.push(
			`- **OVERFLOW** model \`${overflow}\` — use ONLY for spawns running concurrently BEYOND the ${n}-slot DEFAULTS pool (the ${n + 1}th+ at once).`,
			`- On a spawn returning model-unavailable / error / FAILED → escalate that one to OVERFLOW.`,
		);
	} else {
		lines.push(
			`- **OVERFLOW**: none. If you need more parallelism than the DEFAULTS pool, run the extra spawns SEQUENTIALLY rather than switching models.`,
		);
	}
	return lines.join("\n");
}

// ─── Persistent role mode (per-turn system-prompt injection) ──────────────

const COMMON_RULES_PATH = path.join(EXT_DIR, "common-orchestrator.md");
let _commonRules: string | null = null;
function loadCommonRules(): string {
	if (_commonRules === null) {
		try {
			_commonRules = fs.readFileSync(COMMON_RULES_PATH, "utf-8").trim();
		} catch {
			_commonRules = "";
		}
	}
	return _commonRules;
}

const ROLE_BY_KEY = new Map(ROLES.map((r) => [r.key, r] as const));

/** Active orchestrator mode (module-global; reset on /reload — no restore). */
let activeMode: string | null = null;
let activeDefaults: string[] = [];
let activeOverflow: string | null = null;
/** Skip the per-turn injection for exactly one turn (the kickoff already
 *  carries the role context inline, so we avoid duplicating it). */
let skipNextInjection = false;

function enterMode(roleKey: string, defaults: string[], overflow: string | null): void {
	activeMode = roleKey;
	activeDefaults = defaults;
	activeOverflow = overflow;
}

function exitMode(): void {
	activeMode = null;
	activeDefaults = [];
	activeOverflow = null;
}

/** The full role context: header + common rules + role prompt + routing block.
 *  Used both as the kickoff user message (with the real task) and as the
 *  per-turn system-prompt injection (with a generic task reference). */
function buildModeText(roleKey: string, taskText: string): string {
	const role = ROLE_BY_KEY.get(roleKey);
	if (!role) return "";
	const body = loadOrchestratorBody(role).replace(/\{\{QUESTION\}\}/g, taskText);
	const common = loadCommonRules();
	const parts = [`# ORCHESTRATOR MODE: ${role.verb.toUpperCase()}`];
	if (common) parts.push(`\n\n${common}`);
	parts.push(`\n\n${body}`);
	parts.push(buildRoutingBlock(activeDefaults, activeOverflow));
	return parts.join("");
}

/** Per-turn system-prompt suffix while a mode is active. APPENDED AT THE END so
 *  the AGENTS.md + tool-definition prefix stays cacheable across turns. */
function buildModeAppendix(): string {
	if (!activeMode) return "";
	const text = buildModeText(
		activeMode,
		"the user's current request in this conversation",
	);
	return text ? `\n\n---\n\n${text}` : "";
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	for (const role of ROLES) {
		// ── /<role> <task> | (no args → show status) ──────────────────────
		pi.registerCommand(role.key, {
			description: `Run the ${role.verb} orchestrator (/${role.key} <task>)`,
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const cfg = loadConfig();
				const r = resolveRole(cfg, role.key);
				const state = stateFor(ctx, role.key);
				const defaults = effectiveDefaults(state, r);
				const overflow = effectiveOverflow(state, r);
				const question = (args ?? "").trim();

				// Tab title on the first real prompt only (shared with
				// session-tab-title.ts via process global).
				const _s = ((process as any).__piTabTitleState ??= {
					done: false,
				}) as { done: boolean; title?: string };
				if (ctx.hasUI && question && !_s.done) {
					const _t =
						question.length > 50 ? question.slice(0, 50) + "…" : question;
					ctx.ui.setTitle(_t);
					_s.done = true;
					_s.title = _t;
					// Persist so session-tab-title.ts can restore it after /reload.
					try {
						pi.appendEntry("session-tab-title", { title: _t });
					} catch {
						/* best-effort */
					}
				}

				// Enter (or switch to) this role's persistent orchestrator mode.
				enterMode(role.key, defaults, overflow);

				if (question === "") {
					const ov =
						overflow && !defaults.includes(overflow)
							? overflow
							: "none (serialize beyond the pool)";
					ctx.ui.notify(
						`${role.verb} orchestrator mode ACTIVE (role prompt injected every turn).\n` +
							`  defaults : ${defaults.join(", ")}${state.primary ? "" : "  (config)"}\n` +
							`  overflow : ${ov}${state.overflow === undefined ? "  (config)" : ""}\n\n` +
							"Type your task next, or:\n" +
							`  /${role.key} <task>          enter mode and start the task in one step\n` +
							`  /${role.key}:models          change the primary model\n` +
							`  /${role.key}:overflow        change the parallel-overflow model\n` +
							`  /orchestrator:exit           leave orchestrator mode`,
						"info",
					);
					return;
				}

				// One-step entry: deliver the role context + task as the kickoff
				// message (the proven path), then let per-turn injection carry the
				// role on subsequent turns. Skip injecting on this first turn so the
				// kickoff's role context is not duplicated.
				skipNextInjection = true;
				pi.sendUserMessage(buildModeText(role.key, question));
			},
		});

		// ── /<role>:models — pick PRIMARY (= DEFAULTS[0]) ─────────────────
		pi.registerCommand(`${role.key}:models`, {
			description: `Pick the primary ${role.verb} model for this session`,
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				const cfg = loadConfig();
				const r = resolveRole(cfg, role.key);
				const choices = buildModelChoices(r, ctx);
				if (choices.length === 0) {
					ctx.ui.notify(
						"No models available. Configure API keys or edit:\n" + CONFIG_PATH,
						"error",
					);
					return;
				}
				const picked = await ctx.ui.select(
					`Primary ${role.verb} model for this session:`,
					choices.map((c) => c.label),
				);
				if (picked === undefined) {
					ctx.ui.notify("Unchanged (cancelled).", "info");
					return;
				}
				const chosen = choices.find((c) => c.label === picked);
				if (!chosen) {
					ctx.ui.notify("Internal error: unknown selection.", "error");
					return;
				}
				stateFor(ctx, role.key).primary = chosen.id;
				if (activeMode === role.key) {
					const st = stateFor(ctx, role.key);
					activeDefaults = effectiveDefaults(st, r);
					activeOverflow = effectiveOverflow(st, r);
				}
				ctx.ui.notify(
					`${role.verb} primary model set to: ${chosen.id}\n` +
						`Run /${role.key} <task> to use it (this session only).`,
					"success",
				);
			},
		});

		// ── /<role>:overflow — pick OVERFLOW model (or none) ──────────────
		pi.registerCommand(`${role.key}:overflow`, {
			description: `Pick the overflow model for extra concurrent ${role.verb} spawns (or none)`,
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				const cfg = loadConfig();
				const r = resolveRole(cfg, role.key);
				const modelChoices = buildModelChoices(r, ctx);
				if (modelChoices.length === 0) {
					ctx.ui.notify(
						"No models available. Configure API keys or edit:\n" + CONFIG_PATH,
						"error",
					);
					return;
				}
				const labels = [NONE_LABEL, ...modelChoices.map((c) => c.label)];
				const picked = await ctx.ui.select(
					`Overflow model for concurrent ${role.verb} spawns:`,
					labels,
				);
				if (picked === undefined) {
					ctx.ui.notify("Unchanged (cancelled).", "info");
					return;
				}
				if (picked === NONE_LABEL) {
					stateFor(ctx, role.key).overflow = null;
					if (activeMode === role.key)
						activeOverflow = effectiveOverflow(stateFor(ctx, role.key), r);
					ctx.ui.notify(
						"Overflow disabled — extra concurrent spawns serialize on the primary model.",
						"success",
					);
					return;
				}
				const chosen = modelChoices.find((c) => c.label === picked);
				if (!chosen) {
					ctx.ui.notify("Internal error: unknown selection.", "error");
					return;
				}
				stateFor(ctx, role.key).overflow = chosen.id;
				if (activeMode === role.key)
					activeOverflow = effectiveOverflow(stateFor(ctx, role.key), r);
				ctx.ui.notify(`${role.verb} overflow model set to: ${chosen.id}`, "success");
			},
		});
	}

	// ── /orchestrator:models — set PRIMARY for ALL roles at once ───────────
	pi.registerCommand("orchestrator:models", {
		description:
			"Set the primary model for ALL subagent roles at once (this session)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const cfg = loadConfig();
			const choices = buildModelChoices(
				{ catalog: cfg.models, defaults: [], overflow: null },
				ctx,
			);
			if (choices.length === 0) {
				ctx.ui.notify(
					"No models available. Configure API keys or edit:\n" + CONFIG_PATH,
					"error",
				);
				return;
			}
			const picked = await ctx.ui.select(
				"Primary model for ALL roles (this session):",
				choices.map((c) => c.label),
			);
			if (picked === undefined) {
				ctx.ui.notify("Unchanged (cancelled).", "info");
				return;
			}
			const chosen = choices.find((c) => c.label === picked);
			if (!chosen) {
				ctx.ui.notify("Internal error: unknown selection.", "error");
				return;
			}
			const override = await ctx.ui.confirm(
				"ロール設定を上書きしますか？",
				`選択モデル: ${chosen.id}\n\n` +
					"Yes → 全ロールをこのモデルにする（roles の個別 primary 設定を無視）\n" +
					"No  → roles に primary 設定があるロールはそのまま、未設定のロールだけこのモデルにする",
			);
			const applied: string[] = [];
			const kept: string[] = [];
			for (const role of ROLES) {
				if (!override && roleHasPrimaryConfig(cfg, role.key)) {
					kept.push(role.key);
					continue;
				}
				stateFor(ctx, role.key).primary = chosen.id;
				applied.push(role.key);
			}
			ctx.ui.notify(
				`Primary model = ${chosen.id} (this session)\n` +
					`  適用: ${applied.join(", ") || "(なし)"}` +
					(kept.length ? `\n  role設定を優先(据え置き): ${kept.join(", ")}` : ""),
				"success",
			);
		},
	});

	// ── /orchestrator:overflow — set OVERFLOW for ALL roles at once ────────
	pi.registerCommand("orchestrator:overflow", {
		description:
			"Set the overflow model for ALL subagent roles at once, or none (this session)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const cfg = loadConfig();
			const modelChoices = buildModelChoices(
				{ catalog: cfg.models, defaults: [], overflow: null },
				ctx,
			);
			if (modelChoices.length === 0) {
				ctx.ui.notify(
					"No models available. Configure API keys or edit:\n" + CONFIG_PATH,
					"error",
				);
				return;
			}
			const labels = [NONE_LABEL, ...modelChoices.map((c) => c.label)];
			const picked = await ctx.ui.select(
				"Overflow model for ALL roles (this session):",
				labels,
			);
			if (picked === undefined) {
				ctx.ui.notify("Unchanged (cancelled).", "info");
				return;
			}
			const newOverflow: string | null =
				picked === NONE_LABEL
					? null
					: (modelChoices.find((c) => c.label === picked)?.id ?? null);
			if (picked !== NONE_LABEL && newOverflow === null) {
				ctx.ui.notify("Internal error: unknown selection.", "error");
				return;
			}
			const override = await ctx.ui.confirm(
				"ロール設定を上書きしますか？",
				`選択: ${newOverflow ?? "none"}\n\n` +
					"Yes → 全ロールに適用（roles の個別 overflow 設定を無視）\n" +
					"No  → roles に overflow 設定があるロールはそのまま、未設定のロールだけ適用",
			);
			const applied: string[] = [];
			const kept: string[] = [];
			for (const role of ROLES) {
				if (!override && roleHasOverflowConfig(cfg, role.key)) {
					kept.push(role.key);
					continue;
				}
				stateFor(ctx, role.key).overflow = newOverflow;
				applied.push(role.key);
			}
			ctx.ui.notify(
				`Overflow = ${newOverflow ?? "none (serialize)"} (this session)\n` +
					`  適用: ${applied.join(", ") || "(なし)"}` +
					(kept.length ? `\n  role設定を優先(据え置き): ${kept.join(", ")}` : ""),
				"success",
			);
		},
	});

	// ── /orchestrator:exit — leave the active role-mode ───────────────────
	pi.registerCommand("orchestrator:exit", {
		description: "Exit the active orchestrator role-mode (stop per-turn injection)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!activeMode) {
				ctx.ui.notify("No orchestrator mode is active.", "info");
				return;
			}
			const prev = activeMode;
			exitMode();
			skipNextInjection = false;
			ctx.ui.notify(`Exited ${prev} orchestrator mode.`, "success");
		},
	});

	// ── Per-turn injection: append role prompt + common rules + routing ───
	// Appended at the END of the system prompt so the AGENTS.md + tool prefix
	// stays cacheable across turns (only the appended suffix is new). The kickoff
	// turn is skipped because its message already carries the role context.
	pi.on("before_agent_start", async (event: any, ctx: any) => {
		if (!activeMode) return;
		if (skipNextInjection) {
			skipNextInjection = false;
			return;
		}
		let appendix = buildModeAppendix();
		if (activeMode === "planner") {
			const u = ctx.getContextUsage?.();
			if (u && u.contextWindow > 0) {
				const pct =
					u.percent != null
						? Math.round(u.percent)
						: Math.round((u.tokens / u.contextWindow) * 100);
				appendix +=
					`\n\n[CONTEXT USAGE: ${pct}% (${u.tokens ?? "?"}/${u.contextWindow} tokens)]` +
					` — プラン確定時、この値とプランの自己完結度を経、` +
					`新セッション(最安・情報欠落リスク)か同セッション継続(欠落無し・割高)かをユーザーへ提案せよ。`;
			}
		}
		if (!appendix) return;
		return { systemPrompt: (event.systemPrompt ?? "") + appendix };
	});
}
