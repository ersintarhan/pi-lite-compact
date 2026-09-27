import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryFileOps, type Deps, loadConfig, overThreshold, parseModelRef, register } from "./index";

// --- fakes -------------------------------------------------------------------------------

type Handler = (event: any, ctx: any) => unknown;

const dir = mkdtempSync(join(tmpdir(), "plc-"));
const cfgPath = join(dir, "lite-compact.json");
const writeCfg = (cfg: unknown) => writeFileSync(cfgPath, typeof cfg === "string" ? cfg : JSON.stringify(cfg));

const fileOps = () => ({ read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() });
const prep = () => ({ firstKeptEntryId: "e9", tokensBefore: 1000, fileOps: fileOps() }) as any;
const MODEL = { provider: "minimax", id: "MiniMax-M3", baseUrl: "https://orig" };

let compactCalls: unknown[][];
let compactImpl: (...a: unknown[]) => Promise<unknown>;
let notes: string[];

function setup(auth: any = { ok: true, apiKey: "k", headers: { a: "1", gone: null }, env: { E: "1" } }) {
	const handlers: Record<string, Handler> = {};
	const pi = { on: (name: string, h: Handler) => (handlers[name] = h) } as any;
	const deps: Deps = {
		configPath: cfgPath,
		compact: ((...a: unknown[]) => {
			compactCalls.push(a);
			return compactImpl(...a);
		}) as any,
	};
	register(pi, deps);
	const ctx = {
		ui: { notify: (m: string) => notes.push(m) },
		modelRegistry: {
			find: (p: string, id: string) => (p === MODEL.provider && id === MODEL.id ? MODEL : undefined),
			getApiKeyAndHeaders: async () => auth,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 70, contextWindow: 100, percent: 70 }),
		compact: (o: any) => ctx.compactOpts.push(o),
		compactOpts: [] as any[],
	};
	const event = (over: object = {}) => ({
		preparation: prep(),
		branchEntries: [],
		customInstructions: "focus auth",
		signal: new AbortController().signal,
		...over,
	});
	return { handlers, ctx, event };
}

beforeEach(() => {
	compactCalls = [];
	compactImpl = async () => ({ summary: "S", firstKeptEntryId: "e9", tokensBefore: 1000 });
	notes = [];
	writeCfg({});
});

// --- pure helpers ------------------------------------------------------------------------

test("parseModelRef", () => {
	expect(parseModelRef("minimax/MiniMax-M3")).toEqual(["minimax", "MiniMax-M3"]);
	expect(parseModelRef("openrouter/qwen/qwen3")).toEqual(["openrouter", "qwen/qwen3"]);
	for (const bad of ["nomodel", "/x", "x/", "", 42, undefined]) expect(parseModelRef(bad)).toBeUndefined();
});

test("loadConfig: missing file, valid, invalid", () => {
	expect(loadConfig(join(dir, "nope.json"))).toEqual({});
	writeCfg({ model: "a/b", thresholdPercent: 60 });
	expect(loadConfig(cfgPath)).toEqual({ model: "a/b", thresholdPercent: 60 });
	writeCfg("{oops");
	expect(() => loadConfig(cfgPath)).toThrow("invalid JSON");
	writeCfg({ model: "noslash" });
	expect(() => loadConfig(cfgPath)).toThrow("provider/modelId");
	writeCfg({ thresholdPercent: 0 });
	expect(() => loadConfig(cfgPath)).toThrow("thresholdPercent");
	writeCfg({ thresholdPercent: "60" });
	expect(() => loadConfig(cfgPath)).toThrow("thresholdPercent");
});

test("carryFileOps re-adds the previous compaction's file lists", () => {
	const p = prep();
	p.fileOps.read.add("own.ts");
	carryFileOps(p, [
		{ type: "compaction", details: { readFiles: ["old.ts"], modifiedFiles: ["stale.ts"] } },
		{ type: "message" },
		{ type: "compaction", fromHook: true, details: { readFiles: ["a.ts", 7], modifiedFiles: ["b.ts"] } },
		{ type: "message" },
	] as any);
	expect([...p.fileOps.read]).toEqual(["own.ts", "a.ts"]);
	expect([...p.fileOps.edited]).toEqual(["b.ts"]);

	const q = prep();
	carryFileOps(q, [{ type: "compaction" }, { type: "message" }] as any); // no details: no-op
	expect(q.fileOps.read.size + q.fileOps.edited.size).toBe(0);
});

test("overThreshold", () => {
	expect(overThreshold({ tokens: 60, contextWindow: 100, percent: 60 }, 60)).toBe(true);
	expect(overThreshold({ tokens: 59, contextWindow: 100, percent: 59.9 }, 60)).toBe(false);
	expect(overThreshold({ tokens: null, contextWindow: 100, percent: null }, 60)).toBe(false); // right after compaction
	expect(overThreshold(undefined, 60)).toBe(false);
});

// --- session_before_compact ----------------------------------------------------------------

test("no model configured: native compaction untouched", async () => {
	const { handlers, ctx, event } = setup();
	expect(await handlers.session_before_compact!(event(), ctx)).toBeUndefined();
	expect(compactCalls).toHaveLength(0);
	expect(notes).toEqual([]);
});

test("configured model: runs pi's compact with that model, auth and instructions", async () => {
	writeCfg({ model: "minimax/MiniMax-M3" });
	const { handlers, ctx, event } = setup({ ok: true, apiKey: "k", headers: { a: "1", gone: null }, baseUrl: "https://proxy", env: { E: "1" } });
	const ev = event();
	const res = await handlers.session_before_compact!(ev, ctx);
	expect(res).toEqual({ compaction: { summary: "S", firstKeptEntryId: "e9", tokensBefore: 1000 } });
	const [p, model, apiKey, headers, instr, signal, , , env] = compactCalls[0]!;
	expect(p).toBe(ev.preparation);
	expect(model).toEqual({ ...MODEL, baseUrl: "https://proxy" });
	expect(apiKey).toBe("k");
	expect(headers).toEqual({ a: "1" }); // null = deleted header
	expect(instr).toBe("focus auth");
	expect(signal).toBe(ev.signal);
	expect(env).toEqual({ E: "1" });
	expect(notes).toEqual([]);
});

test("fallbacks: unknown model, auth failure, compact error, bad config", async () => {
	const run = async (cfg: unknown, auth?: any) => {
		writeCfg(cfg);
		notes = [];
		const { handlers, ctx, event } = setup(auth);
		return handlers.session_before_compact!(event(), ctx);
	};
	expect(await run({ model: "x/y" })).toBeUndefined();
	expect(notes[0]).toContain("x/y not found");

	expect(await run({ model: "minimax/MiniMax-M3" }, { ok: false, error: "no key" })).toBeUndefined();
	expect(notes[0]).toContain("no key");

	compactImpl = async () => {
		throw new Error("context too long");
	};
	expect(await run({ model: "minimax/MiniMax-M3" })).toBeUndefined();
	expect(notes[0]).toContain("context too long");

	expect(await run("{oops")).toBeUndefined();
	expect(notes[0]).toContain("bad config");
});

test("aborted compaction fails quietly", async () => {
	writeCfg({ model: "minimax/MiniMax-M3" });
	const ac = new AbortController();
	compactImpl = async () => {
		ac.abort();
		throw new Error("aborted");
	};
	const { handlers, ctx, event } = setup();
	expect(await handlers.session_before_compact!(event({ signal: ac.signal }), ctx)).toBeUndefined();
	expect(notes).toEqual([]);
});

// --- agent_settled -----------------------------------------------------------------------

test("settled trigger: off without threshold, fires once over it, rearms after completion", () => {
	const { handlers, ctx } = setup();
	handlers.agent_settled!({}, ctx);
	expect(ctx.compactOpts).toHaveLength(0);

	writeCfg({ thresholdPercent: 60 });
	handlers.agent_settled!({}, ctx);
	handlers.agent_settled!({}, ctx); // in flight: ignored
	expect(ctx.compactOpts).toHaveLength(1);

	ctx.compactOpts[0].onError(new Error("boom"));
	expect(notes[0]).toContain("boom");
	handlers.agent_settled!({}, ctx);
	expect(ctx.compactOpts).toHaveLength(2);
	ctx.compactOpts[1].onComplete({});

	writeCfg({ thresholdPercent: 80 }); // 70% < 80%
	handlers.agent_settled!({}, ctx);
	expect(ctx.compactOpts).toHaveLength(2);
});

test("settled trigger: skips when busy or messages are queued", () => {
	writeCfg({ thresholdPercent: 60 });
	const { handlers, ctx } = setup();
	ctx.isIdle = () => false;
	handlers.agent_settled!({}, ctx);
	ctx.isIdle = () => true;
	ctx.hasPendingMessages = () => true;
	handlers.agent_settled!({}, ctx);
	expect(ctx.compactOpts).toHaveLength(0);
});
