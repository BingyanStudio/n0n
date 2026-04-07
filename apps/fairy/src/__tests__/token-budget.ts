/**
 * Token 预算估算 — 计算合理的窗口参数
 *
 * 运行: bun apps/fairy/src/__tests__/token-budget.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPrompt } from "@n0n/shared";
import type { DomainMessage, SubmitToolResult } from "@n0n/types";
import type { FairyPaths } from "../state.ts";
import { buildView } from "../view.ts";

const testDir = mkdtempSync(join(tmpdir(), "fairy-token-"));
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
	"# Identity\n\nYou are a helpful fairy companion.\n\n## Traits\n\n- Friendly\n- Proactive",
	"utf-8",
);
writeFileSync(
	paths.memoryFile,
	"# Memory\n\nUser prefers Chinese responses.\nUser works on a TypeScript monorepo project called n0n.",
	"utf-8",
);

// ── 模拟轮次 ──

function makeQuickRound(i: number): DomainMessage[] {
	return [
		{
			type: "user_input",
			content: `你好，今天天气怎么样？这是第${i}轮对话，我想聊聊最近的工作进展和一些技术问题。`,
			context: null,
			hint: null,
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
							reply: `你好！今天天气不错呢。关于你的工作进展，我记得你上次提到在做 n0n 项目的 fairy 模块。有什么具体的技术问题想讨论吗？我很乐意帮忙分析。`,
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

function makeToolRound(i: number): DomainMessage[] {
	return [
		{
			type: "user_input",
			content:
				"帮我检查一下 apps/fairy/src/view.ts 的代码结构，看看有没有什么可以优化的地方",
			context: null,
			hint: null,
		},
		{
			type: "assistant_tool_call",
			content: null,
			toolCalls: [
				{
					id: `r-${i}`,
					tool: "reminder",
					args: {
						content: `O: 检查 view.ts 代码结构\nKR: [ ] 读取文件 [ ] 分析结构 [ ] 提出优化建议\n当前：开始读取`,
						estimate: 3,
						is_completed_and_i_will_immediately_call_the_next_tool: true,
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
				args: { content: "...", estimate: 3 , is_completed_and_i_will_immediately_call_the_next_tool: true },
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
						script: "type apps\\fairy\\src\\view.ts",
						runtime: "cmd",
						cwd: ".",
					},
				},
			],
		},
		{
			type: "tool_result",
			tool: "exec",
			status: "completed" as const,
			call: {
				id: `e-${i}`,
				tool: "exec",
				args: {
					script: "type apps\\fairy\\src\\view.ts",
					runtime: "cmd",
					cwd: ".",
				},
			},
			exitCode: 0,
			stdout:
				'/**\n * View — 从状态组装上下文\n *\n * 核心创新：不直接使用对话历史，而是从全局状态重建上下文。\n */\n\nimport type { DomainMessage } from "@n0n/types";\n\nexport function buildView(...) { ... }\n\n// ... 约 200 行代码 ...\n',
			stderr: "",
			durationMs: 50,
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
							reply:
								"view.ts 的结构很清晰：\n1. 配置常量（SUMMARY_THRESHOLD 等）\n2. 对话路径提取函数\n3. buildView 主函数\n4. 内部构建函数\n\n优化建议：可以考虑将 extractPathLines 的结果缓存，避免每轮重复提取。",
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

// ── 估算 ──

const MODEL = "gpt-4";
let history: DomainMessage[] = [];

console.log("=== Per-Round Token Estimation ===\n");

const measurements: number[] = [];
let prevTokens = 0;

for (let r = 1; r <= 60; r++) {
	const round = r % 3 === 0 ? makeToolRound(r) : makeQuickRound(r);
	history = [...history, ...round];

	const view = buildView(history, paths, "test");
	const serialized = formatPrompt(view, MODEL);
	const totalChars = serialized.reduce(
		(s, m) => s + (typeof m.content === "string" ? m.content.length : 0),
		0,
	);
	// Chinese-heavy: ~2-3 chars per token; mixed: ~3 chars per token
	const estTokens = Math.round(totalChars / 3);
	const delta = estTokens - prevTokens;
	if (r <= 20 || r % 10 === 0) {
		console.log(
			`  Round ${String(r).padStart(2)}: ${String(totalChars).padStart(6)} chars ≈ ${String(estTokens).padStart(5)} tokens (Δ${delta > 0 ? "+" : ""}${delta})`,
		);
	}
	measurements.push(delta > 0 ? delta : estTokens);
	prevTokens = estTokens;
}

// Average tokens per round (delta)
const avgDelta =
	measurements.slice(1).reduce((s, d) => s + d, 0) / (measurements.length - 1);
console.log(`\nAvg tokens per round (incremental): ~${Math.round(avgDelta)}`);

// Budget calculation
const CONTEXT_WINDOW = 128000;
const TRIGGER_PERCENT = 0.8;
const TRIGGER_AT = Math.round(CONTEXT_WINDOW * TRIGGER_PERCENT);
const SYSTEM_OVERHEAD = 1500; // identity + memory + env + prompt
const _SUMMARY_RATIO = 0.2; // summary is ~20% of original (compressed)

console.log(`\n=== Budget Calculation ===`);
console.log(`Context window: ${CONTEXT_WINDOW} tokens`);
console.log(`Trigger at ${TRIGGER_PERCENT * 100}%: ${TRIGGER_AT} tokens`);
console.log(`System overhead: ~${SYSTEM_OVERHEAD} tokens`);
console.log(`Avg tokens/round: ~${Math.round(avgDelta)}`);

const historyBudget = TRIGGER_AT - SYSTEM_OVERHEAD;
const roundsToFill = Math.floor(historyBudget / avgDelta);
console.log(`Rounds to fill 80%: ~${roundsToFill}`);

// After compression: summary ≈ 25k, tail gets the rest
const COMPRESSED_TARGET = 25000;
const tailBudget = TRIGGER_AT - COMPRESSED_TARGET - SYSTEM_OVERHEAD;
const tailRounds = Math.floor(tailBudget / avgDelta);
const step = roundsToFill;

console.log(`\nAfter compression:`);
console.log(`  Summary target: ~${COMPRESSED_TARGET} tokens`);
console.log(
	`  Tail budget: ~${Math.round(tailBudget)} tokens → ~${tailRounds} rounds`,
);
console.log(`  Step (rounds between compressions): ~${step}`);

console.log(`\n=== Recommended Parameters ===`);
console.log(`SUMMARY_THRESHOLD = ${roundsToFill}`);
console.log(`SUMMARY_STEP = ${step}`);
console.log(`TAIL_ROUNDS = ${tailRounds}`);

rmSync(testDir, { recursive: true, force: true });
