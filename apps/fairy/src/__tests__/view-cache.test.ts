/**
 * View 缓存命中率测试
 *
 * 模拟多轮对话（含大量工具输出），测量：
 * 1. 压缩触发时机
 * 2. 相邻轮次间 prompt 前缀稳定性（KV-cache 命中率）
 *
 * 运行: bun apps/fairy/src/__tests__/view-cache.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAPIMessages } from "@n0n/llm";
import type { DomainMessage, SubmitToolResult } from "@n0n/types";
import type { FairyPaths } from "../state.ts";
import { buildView } from "../view.ts";

// ── 测试用 workspace ──

const testDir = mkdtempSync(join(tmpdir(), "fairy-cache-test-"));
const paths: FairyPaths = {
	workspace: testDir,
	temp: join(testDir, ".temp"),
	historyFile: join(testDir, "history.json"),
	identityFile: join(testDir, "identity.md"),
	memoryFile: join(testDir, "memory.md"),
};

mkdirSync(paths.temp, { recursive: true });
writeFileSync(
	paths.identityFile,
	"# Identity\n\nYou are a test fairy with a detailed personality.\n\n## Traits\n\n- Friendly and curious\n- Proactive\n- Technical",
	"utf-8",
);
writeFileSync(
	paths.memoryFile,
	"# Memory\n\nUser likes cats.\nUser works on TypeScript projects.\nUser prefers Chinese responses.",
	"utf-8",
);

// ── 模拟对话历史（含大量工具输出，模拟真实场景） ──

/** 快速对话轮（~200 tokens） */
function makeQuickRound(i: number): DomainMessage[] {
	return [
		{
			type: "user_input",
			content: `你好，这是第${i}轮对话。我想聊聊最近的工作进展和一些技术问题，比如 TypeScript 的类型体操。`,
			context: null,
			capabilities: null,
		},
		{
			type: "assistant_tool_call",
			content: null,
			toolCalls: [
				{
					id: `s-${i}`,
					tool: "submit",
					args: {
						result: {
							reply: `你好！关于 TypeScript 类型体操，这是个很有趣的话题。最近 TypeScript 5.x 引入了很多新特性，比如 const type parameters 和 satisfies 操作符。你具体想讨论哪方面？条件类型、映射类型、还是模板字面量类型？`,
						},
					},
				},
			],
		},
		{
			type: "tool_result",
			tool: "submit",
			call: {
				id: `s-${i}`,
				tool: "submit",
				args: { result: { reply: "..." } },
			},
			cleanedResult: { reply: "..." },
		} satisfies SubmitToolResult,
	];
}

/** 工具使用轮（~2000 tokens，含大量 exec 输出） */
function makeHeavyToolRound(i: number): DomainMessage[] {
	// 模拟读取文件的大量输出
	const fakeFileContent = Array.from(
		{ length: 80 },
		(_, j) =>
			`L${j + 1}: ${"  ".repeat(j % 4)}${["import", "export", "function", "const", "if", "for", "return"][j % 7]} ${`item_${j}_round_${i}`}(${j % 3 === 0 ? "arg: string" : ""}) { /* implementation details for line ${j} with some realistic code content */ }`,
	).join("\n");

	return [
		{
			type: "user_input",
			content: `帮我分析一下 src/module-${i}.ts 的代码结构，找出潜在的性能问题和可优化的地方。`,
			context: null,
			capabilities: null,
		},
		{
			type: "assistant_tool_call",
			content: null,
			toolCalls: [
				{
					id: `r-${i}`,
					tool: "reminder",
					args: {
						content: `O: 分析 module-${i}.ts\nKR: [ ] 读取代码 [ ] 识别性能问题 [ ] 提出优化方案\n当前：开始读取文件`,
						delay: 3,
					},
				},
			],
		},
		{
			type: "tool_result",
			tool: "reminder",
			call: {
				id: `r-${i}`,
				tool: "reminder",
				args: { content: "...", delay: 3 },
			},
			acknowledged: true as const,
		},
		{
			type: "assistant_tool_call",
			content: null,
			toolCalls: [
				{
					id: `e-${i}`,
					tool: "exec",
					args: {
						script: `type src\\module-${i}.ts`,
						runtime: "cmd",
						cwd: ".",
					},
				},
			],
		},
		{
			type: "tool_result",
			tool: "exec",
			call: {
				id: `e-${i}`,
				tool: "exec",
				args: { script: `type src\\module-${i}.ts`, runtime: "cmd", cwd: "." },
			},
			exitCode: 0,
			stdout: fakeFileContent,
			stderr: "",
			durationMs: 45,
		},
		{
			type: "assistant_tool_call",
			content: null,
			toolCalls: [
				{
					id: `s-${i}`,
					tool: "submit",
					args: {
						result: {
							reply: `分析完成 module-${i}.ts：\n\n1. **性能问题**：第 15 行的循环内有不必要的对象创建，建议提取到循环外\n2. **类型安全**：第 30 行使用了 any 类型，建议用泛型替代\n3. **代码结构**：函数过长（80行），建议拆分为 3 个子函数\n\n需要我帮你实现这些优化吗？`,
						},
					},
				},
			],
		},
		{
			type: "tool_result",
			tool: "submit",
			call: {
				id: `s-${i}`,
				tool: "submit",
				args: { result: { reply: "..." } },
			},
			cleanedResult: { reply: "..." },
		} satisfies SubmitToolResult,
	];
}

// ── 序列化与比较 ──

const MODEL = "gpt-4";

function serializeView(messages: DomainMessage[]): string {
	const apiMsgs = toAPIMessages(messages, MODEL);
	return apiMsgs
		.map(
			(m) =>
				`[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
		)
		.join("\n---MSG---\n");
}

function commonPrefixLength(a: string, b: string): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (a[i] !== b[i]) return i;
	}
	return len;
}

function estimateTokens(s: string): number {
	return Math.round(s.length / 3);
}

// ── 运行测试 ──

const TOTAL_ROUNDS = 80;

console.log("=== View Cache Hit Rate Test (Realistic Scenario) ===\n");
console.log(
	`Simulating ${TOTAL_ROUNDS} rounds (mix of quick chat + heavy tool use).\n`,
);

let history: DomainMessage[] = [];
let prevSerialized = "";
let compressTriggered = false;

const results: {
	round: number;
	totalTokens: number;
	rawHistoryTokens: number;
	prefixTokens: number;
	hitRate: number;
	compressed: boolean;
}[] = [];

for (let r = 1; r <= TOTAL_ROUNDS; r++) {
	// Mix: 1/3 heavy tool rounds, 2/3 quick chat
	const round = r % 3 === 0 ? makeHeavyToolRound(r) : makeQuickRound(r);
	history = [...history, ...round];

	const rawTokens = estimateTokens(JSON.stringify(history));
	const stimulus = `Round ${r + 1} stimulus`;
	const view = buildView(history, paths, stimulus);
	const serialized = serializeView(view);
	const totalTokens = estimateTokens(serialized);

	const isCompressed = totalTokens < rawTokens * 0.9; // significant reduction = compressed
	if (isCompressed && !compressTriggered) {
		compressTriggered = true;
		console.log(
			`*** Compression triggered at round ${r} (raw: ~${rawTokens} tokens) ***\n`,
		);
	}

	if (prevSerialized) {
		const prefix = commonPrefixLength(prevSerialized, serialized);
		const prefixTokens = estimateTokens(serialized.slice(0, prefix));
		const hitRate = totalTokens > 0 ? prefixTokens / totalTokens : 0;
		results.push({
			round: r,
			totalTokens,
			rawHistoryTokens: rawTokens,
			prefixTokens,
			hitRate,
			compressed: isCompressed,
		});
	}

	prevSerialized = serialized;
}

// 输出结果
console.log(
	"Round | Raw Tokens | View Tokens | Prefix Match | Hit Rate | Mode",
);
console.log(
	"------|------------|-------------|--------------|----------|-----",
);
for (const r of results) {
	if (r.round <= 15 || r.round % 5 === 0) {
		const mode = r.compressed ? "SUMMARY" : "RAW";
		const bar =
			"█".repeat(Math.round(r.hitRate * 20)) +
			"░".repeat(20 - Math.round(r.hitRate * 20));
		console.log(
			`  ${String(r.round).padStart(2)}  | ${String(r.rawHistoryTokens).padStart(10)} | ${String(r.totalTokens).padStart(11)} | ${String(r.prefixTokens).padStart(12)} | ${(r.hitRate * 100).toFixed(1).padStart(5)}% ${bar} | ${mode}`,
		);
	}
}

// 汇总
const rawResults = results.filter((r) => !r.compressed);
const compressedResults = results.filter((r) => r.compressed);

console.log(`\n=== Summary ===`);
if (rawResults.length > 0) {
	const avg = rawResults.reduce((s, r) => s + r.hitRate, 0) / rawResults.length;
	console.log(
		`Raw mode (${rawResults.length} rounds): avg hit rate ${(avg * 100).toFixed(1)}%`,
	);
}
if (compressedResults.length > 0) {
	const avg =
		compressedResults.reduce((s, r) => s + r.hitRate, 0) /
		compressedResults.length;
	console.log(
		`Summary mode (${compressedResults.length} rounds): avg hit rate ${(avg * 100).toFixed(1)}%`,
	);

	// Jump points
	const jumps = compressedResults.filter((r) => r.hitRate < 0.5);
	console.log(
		`  Snapshot jumps: ${jumps.length} (rounds: ${jumps.map((j) => j.round).join(", ") || "none"})`,
	);
	const stable = compressedResults.filter((r) => r.hitRate >= 0.5);
	if (stable.length > 0) {
		const stableAvg = stable.reduce((s, r) => s + r.hitRate, 0) / stable.length;
		console.log(
			`  Stable rounds: ${stable.length}, avg hit rate ${(stableAvg * 100).toFixed(1)}%`,
		);
	}
}

const overall = results.reduce((s, r) => s + r.hitRate, 0) / results.length;
console.log(`\nOverall avg hit rate: ${(overall * 100).toFixed(1)}%`);

rmSync(testDir, { recursive: true, force: true });
