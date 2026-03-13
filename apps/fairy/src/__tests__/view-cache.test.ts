/**
 * View 缓存命中率测试
 *
 * 模拟多轮对话，测量相邻轮次间 prompt 前缀的稳定性。
 * 前缀越稳定 → KV-cache 命中率越高。
 *
 * 运行: bun apps/fairy/src/__tests__/view-cache.test.ts
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAPIMessages } from "@n0n/llm";
import type {
	AssistantToolCallMessage,
	DomainMessage,
	SubmitToolResult,
} from "@n0n/types";
import type { FairyPaths } from "../state.ts";
import { buildView, computeSnapshotEnd } from "../view.ts";

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
	"# Identity\n\nYou are a test fairy.",
	"utf-8",
);
writeFileSync(paths.memoryFile, "# Memory\n\nUser likes cats.", "utf-8");

// ── 模拟对话历史生成 ──

function makeRound(roundIdx: number, withReminder: boolean): DomainMessage[] {
	const msgs: DomainMessage[] = [];

	// user_input
	msgs.push({
		type: "user_input",
		content: `Message from user in round ${roundIdx}`,
		context: null,
		capabilities: null,
	});

	// assistant_tool_call with submit (and optionally reminder)
	const toolCalls: AssistantToolCallMessage["toolCalls"] = [];

	if (withReminder) {
		toolCalls.push({
			id: `reminder-${roundIdx}`,
			tool: "reminder",
			args: {
				content: `Round ${roundIdx} progress: doing stuff`,
				delay: 5,
			},
		});
	}

	toolCalls.push({
		id: `submit-${roundIdx}`,
		tool: "submit",
		args: {
			result: { reply: `Fairy reply in round ${roundIdx}` },
		},
	});

	msgs.push({
		type: "assistant_tool_call",
		content: null,
		toolCalls,
	});

	// tool_result for reminder
	if (withReminder) {
		msgs.push({
			type: "tool_result",
			tool: "reminder",
			call: {
				id: `reminder-${roundIdx}`,
				tool: "reminder",
				args: { content: `Round ${roundIdx} progress: doing stuff`, delay: 5 },
			},
			acknowledged: true as const,
		});
	}

	// tool_result for submit
	msgs.push({
		type: "tool_result",
		tool: "submit",
		call: {
			id: `submit-${roundIdx}`,
			tool: "submit",
			args: { result: { reply: `Fairy reply in round ${roundIdx}` } },
		},
		cleanedResult: { reply: `Fairy reply in round ${roundIdx}` },
	} satisfies SubmitToolResult);

	return msgs;
}

// ── 序列化 DomainMessage[] 为可比较的字符串 ──

function serializeView(messages: DomainMessage[], model: string): string {
	const apiMsgs = toAPIMessages(messages, model);
	return apiMsgs
		.map(
			(m) =>
				`[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
		)
		.join("\n---MSG---\n");
}

/** 计算两个字符串的公共前缀长度 */
function commonPrefixLength(a: string, b: string): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (a[i] !== b[i]) return i;
	}
	return len;
}

// ── 运行测试 ──

const MODEL = "gpt-4";
const TOTAL_ROUNDS = 16;

console.log("=== View Cache Hit Rate Test ===\n");
console.log(`Simulating ${TOTAL_ROUNDS} rounds of conversation.\n`);

// 先测试 computeSnapshotEnd
console.log("--- computeSnapshotEnd behavior ---");
for (let r = 1; r <= TOTAL_ROUNDS; r++) {
	const snap = computeSnapshotEnd(r, 3, 4);
	console.log(
		`  rounds=${String(r).padStart(2)} → snapEnd=${snap} (summary covers [0,${snap}), tail covers [${snap},${r}))`,
	);
}
console.log();

// 逐轮构建 history 并比较
let history: DomainMessage[] = [];
let prevSerialized = "";
const results: {
	round: number;
	totalChars: number;
	prefixChars: number;
	hitRate: number;
}[] = [];

for (let r = 1; r <= TOTAL_ROUNDS; r++) {
	// 每隔几轮加 reminder，模拟混合场景
	const withReminder = r % 3 === 0;
	const roundMsgs = makeRound(r, withReminder);
	history = [...history, ...roundMsgs];

	const stimulus = `New message in round ${r + 1}`;
	const view = buildView(history, paths, stimulus);
	const serialized = serializeView(view, MODEL);

	if (prevSerialized) {
		const prefix = commonPrefixLength(prevSerialized, serialized);
		const total = serialized.length;
		const hitRate = total > 0 ? prefix / total : 0;
		results.push({ round: r, totalChars: total, prefixChars: prefix, hitRate });
	}

	prevSerialized = serialized;
}

// 输出结果
console.log("--- Cache Hit Rate per Round ---");
console.log("Round | Total Chars | Prefix Match | Hit Rate");
console.log("------|-------------|--------------|--------");
for (const r of results) {
	const bar =
		"█".repeat(Math.round(r.hitRate * 20)) +
		"░".repeat(20 - Math.round(r.hitRate * 20));
	console.log(
		`  ${String(r.round).padStart(2)}  | ${String(r.totalChars).padStart(11)} | ${String(r.prefixChars).padStart(12)} | ${(r.hitRate * 100).toFixed(1).padStart(5)}% ${bar}`,
	);
}

// 汇总
const avgHitRate =
	results.reduce((sum, r) => sum + r.hitRate, 0) / results.length;
console.log();
console.log(`Average cache hit rate: ${(avgHitRate * 100).toFixed(1)}%`);

// 分段统计：threshold 前 vs 后
const threshold = 6;
const beforeThreshold = results.filter((r) => r.round < threshold);
const afterThreshold = results.filter((r) => r.round >= threshold);

if (beforeThreshold.length > 0) {
	const avg =
		beforeThreshold.reduce((s, r) => s + r.hitRate, 0) / beforeThreshold.length;
	console.log(
		`  Before summary mode (rounds <${threshold}): ${(avg * 100).toFixed(1)}%`,
	);
}
if (afterThreshold.length > 0) {
	const avg =
		afterThreshold.reduce((s, r) => s + r.hitRate, 0) / afterThreshold.length;
	console.log(
		`  After summary mode (rounds >=${threshold}): ${(avg * 100).toFixed(1)}%`,
	);
}

// 跳变点分析
console.log();
console.log("--- Snapshot Jump Points ---");
const jumpPoints = results.filter((r) => r.hitRate < 0.5);
if (jumpPoints.length === 0) {
	console.log("  No major cache invalidations detected (all >50% hit rate)");
} else {
	for (const j of jumpPoints) {
		console.log(
			`  Round ${j.round}: ${(j.hitRate * 100).toFixed(1)}% hit rate (snapshot jumped)`,
		);
	}
}

// cleanup
import { rmSync } from "node:fs";

rmSync(testDir, { recursive: true, force: true });
