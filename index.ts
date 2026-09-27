/**
 * pi-lite-compact: pi's native compaction, summarized by a model of your choice.
 *
 * - session_before_compact: run pi's own `compact()` (same prompt, cut point, split-turn
 *   handling, file lists) with the configured model. Any failure returns nothing, so pi
 *   falls back to native compaction with the session model.
 * - agent_settled (optional): request a compaction once context crosses thresholdPercent.
 *
 * Config: ~/.pi/agent/lite-compact.json  { "model": "provider/modelId", "thresholdPercent": 60 }
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compact,
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

export interface Config {
	/** "provider/modelId" that writes summaries. Unset: native compaction, untouched. */
	model?: string;
	/** Compact when an idle session's context reaches this percent. Unset: pi's own trigger only. */
	thresholdPercent?: number;
}

export interface Deps {
	compact: typeof compact;
	configPath: string;
}

/** Missing file = empty config. Invalid content throws, so a typo is reported instead of ignored. */
export function loadConfig(path: string): Config {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	let cfg: Config;
	try {
		cfg = JSON.parse(raw) as Config;
	} catch (e) {
		throw new Error(`invalid JSON: ${errMsg(e)}`);
	}
	if (cfg.model !== undefined && !parseModelRef(cfg.model)) {
		throw new Error(`model must be "provider/modelId", got ${JSON.stringify(cfg.model)}`);
	}
	const t = cfg.thresholdPercent;
	if (t !== undefined && (typeof t !== "number" || !(t > 0 && t <= 100))) {
		throw new Error(`thresholdPercent must be a number in (0, 100], got ${JSON.stringify(t)}`);
	}
	return cfg;
}

/** Splits on the first "/": model ids may contain slashes themselves. */
export function parseModelRef(ref: unknown): [provider: string, id: string] | undefined {
	if (typeof ref !== "string") return undefined;
	const i = ref.indexOf("/");
	if (i <= 0 || i === ref.length - 1) return undefined;
	return [ref.slice(0, i), ref.slice(i + 1)];
}

/**
 * Pi carries file lists forward only from its own compactions (fromHook=false), so our
 * entries would drop them on the next run. Re-add the previous compaction's lists.
 */
export function carryFileOps(prep: CompactionPreparation, branch: SessionEntry[]): void {
	const prev = branch.findLast((e) => e.type === "compaction");
	const d = prev?.type === "compaction" ? (prev.details as Record<string, unknown> | undefined) : undefined;
	if (!d || typeof d !== "object") return;
	for (const [key, set] of [
		["readFiles", prep.fileOps.read],
		["modifiedFiles", prep.fileOps.edited],
	] as const) {
		const files = d[key];
		if (Array.isArray(files)) for (const f of files) if (typeof f === "string") set.add(f);
	}
}

export function overThreshold(usage: ContextUsage | undefined, thresholdPercent: number): boolean {
	return usage?.percent != null && usage.percent >= thresholdPercent;
}

const warn = (ctx: ExtensionContext, msg: string) => ctx.ui.notify(`lite-compact: ${msg}`, "warning");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readConfig(ctx: ExtensionContext, path: string): Config | undefined {
	try {
		return loadConfig(path);
	} catch (e) {
		warn(ctx, `bad config ${path}: ${errMsg(e)}`);
		return undefined;
	}
}

export function register(pi: ExtensionAPI, deps: Deps): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const ref = parseModelRef(readConfig(ctx, deps.configPath)?.model);
		if (!ref) return;
		const name = ref.join("/");
		const model = ctx.modelRegistry.find(...ref);
		if (!model) return void warn(ctx, `model ${name} not found, using native compaction`);
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return void warn(ctx, `${name}: ${auth.error}, using native compaction`);

		carryFileOps(event.preparation, event.branchEntries);
		const headers = auth.headers
			? Object.fromEntries(Object.entries(auth.headers).filter((h): h is [string, string] => h[1] !== null))
			: undefined;
		try {
			const result = await deps.compact(
				event.preparation,
				auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
				auth.apiKey,
				headers,
				event.customInstructions,
				event.signal,
				undefined,
				undefined,
				auth.env,
			);
			return { compaction: result };
		} catch (e) {
			if (!event.signal.aborted) warn(ctx, `${name} failed (${errMsg(e)}), using native compaction`);
			return;
		}
	});

	// ponytail: a failing compaction is retried on every settle; add a cooldown if that gets noisy.
	let compacting = false;
	pi.on("agent_settled", (_event, ctx) => {
		const threshold = readConfig(ctx, deps.configPath)?.thresholdPercent;
		if (!threshold || compacting || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (!overThreshold(ctx.getContextUsage(), threshold)) return;
		compacting = true;
		ctx.compact({
			onComplete: () => {
				compacting = false;
			},
			onError: (e) => {
				compacting = false;
				warn(ctx, `auto compaction failed: ${e.message}`);
			},
		});
	});
}

export default function (pi: ExtensionAPI) {
	register(pi, { compact, configPath: join(getAgentDir(), "lite-compact.json") });
}
