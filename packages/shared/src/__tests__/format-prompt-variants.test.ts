/**
 * anti-few-shot 变体系统测试
 *
 * 验证两个核心性质：
 * 1. 稳定性（确定性）— 同 index 总是产出相同结果，保证 prompt cache 安全
 * 2. 多样性 — 在真实对话的 index 模式下，变体分布合理
 *
 * 真实对话中 tool_result 的 index 不是连续的，而是等差数列：
 *   单工具: user, atc, tr, user, atc, tr → indices 2, 5, 8, 11... (step=3)
 *   双工具: user, atc, tr, tr, user, atc, tr, tr → indices 2, 3, 6, 7... (step=4, pairs)
 *   三工具: indices 2, 3, 4, 8, 9, 10... (step=5, triples)
 */

import { describe, expect, it } from "bun:test";
import type { DomainMessage } from "@n0n/types";
import { formatPrompt } from "../format-prompt/index.ts";
import { pick } from "../format-prompt/seed.ts";
import { createTagAdapter } from "../tags.ts";

// ── 稳定性测试 ──

describe("pick 稳定性", () => {
	const variants = ["alpha", "beta", "gamma"];

	it("同一 index 多次调用结果一致", () => {
		for (const idx of [0, 1, 5, 42, 100, 999]) {
			const first = pick(variants, idx);
			for (let repeat = 0; repeat < 50; repeat++) {
				expect(pick(variants, idx)).toBe(first);
			}
		}
	});

	it("不同长度的 variants 数组对同一 index 结果稳定", () => {
		const v2 = ["X", "Y"];
		const v5 = ["a", "b", "c", "d", "e"];
		for (const idx of [3, 7, 15, 42]) {
			const r2 = pick(v2, idx);
			const r5 = pick(v5, idx);
			for (let repeat = 0; repeat < 20; repeat++) {
				expect(pick(v2, idx)).toBe(r2);
				expect(pick(v5, idx)).toBe(r5);
			}
		}
	});
});

// ── 多样性测试 ──

describe("pick 多样性", () => {
	const variants = ["A", "B", "C"];

	/** 生成指定模式下的 tool_result index 序列 */
	function toolResultIndices(
		pattern: "single" | "dual" | "triple" | "mixed",
		rounds: number,
	): number[] {
		const indices: number[] = [];
		switch (pattern) {
			case "single":
				// user, atc, tr → step=3
				for (let r = 0; r < rounds; r++) indices.push(2 + r * 3);
				break;
			case "dual":
				// user, atc, tr, tr → step=4, pairs
				for (let r = 0; r < rounds; r++) {
					const base = 2 + r * 4;
					indices.push(base, base + 1);
				}
				break;
			case "triple":
				// user, atc, tr, tr, tr → step=5, triples
				for (let r = 0; r < rounds; r++) {
					const base = 2 + r * 5;
					indices.push(base, base + 1, base + 2);
				}
				break;
			case "mixed": {
				// 真实混合模式
				const toolCounts = [1, 3, 2, 1, 1, 2, 3, 1, 2, 1, 1, 3];
				let idx = 2; // skip system + user_input
				for (let r = 0; r < Math.min(rounds, toolCounts.length); r++) {
					idx++; // assistant_tool_call
					for (let t = 0; t < (toolCounts[r] ?? 0); t++) {
						indices.push(idx);
						idx++;
					}
					idx++; // next user message
				}
				break;
			}
		}
		return indices;
	}

	/**
	 * 统计分布偏差和最大连续重复。
	 * 返回 { maxDeviation: 最大偏离均匀分布的比例, maxRun: 最大连续相同次数, allPresent: 是否所有变体都出现 }
	 */
	function analyzeDistribution(indices: number[]) {
		const picks = indices.map((i) => pick(variants, i));
		const counts = new Map<string, number>();
		for (const p of picks) counts.set(p, (counts.get(p) ?? 0) + 1);

		let maxRun = 1;
		let curRun = 1;
		for (let i = 1; i < picks.length; i++) {
			if (picks[i] === picks[i - 1]) {
				curRun++;
				maxRun = Math.max(maxRun, curRun);
			} else {
				curRun = 1;
			}
		}

		const total = indices.length;
		const expected = 1 / variants.length;
		const maxDeviation = Math.max(
			...[...counts.values()].map((v) => Math.abs(v / total - expected)),
		);

		return {
			maxDeviation,
			maxRun,
			allPresent: counts.size === variants.length,
		};
	}

	// 大样本（≥30 个 tool_result）：统计性质应该明确
	it.each([
		{ pattern: "single" as const, rounds: 50 },
		{ pattern: "dual" as const, rounds: 30 },
		{ pattern: "triple" as const, rounds: 20 },
	])("大样本 $pattern x $rounds 轮：所有变体出现 + 偏差 <15%", ({
		pattern,
		rounds,
	}) => {
		const indices = toolResultIndices(pattern, rounds);
		const { maxDeviation, allPresent } = analyzeDistribution(indices);
		expect(allPresent).toBe(true);
		expect(maxDeviation).toBeLessThan(0.15);
	});

	// 中样本（10-20 轮的典型对话）：至少不会退化成只选一个
	it.each([
		{ pattern: "single" as const, rounds: 10 },
		{ pattern: "dual" as const, rounds: 8 },
		{ pattern: "triple" as const, rounds: 5 },
		{ pattern: "mixed" as const, rounds: 12 },
	])("中样本 $pattern x $rounds 轮：至少出现 2 种变体", ({
		pattern,
		rounds,
	}) => {
		const indices = toolResultIndices(pattern, rounds);
		const picks = indices.map((i) => pick(variants, i));
		const unique = new Set(picks);
		expect(unique.size).toBeGreaterThanOrEqual(2);
	});

	// χ² 检验：1000 样本下各等差步长分布均匀
	it.each([1, 2, 3, 4, 5])("χ² 检验 step=%i x1000：p>0.01", (step) => {
		const indices = Array.from({ length: 1000 }, (_, i) => 2 + i * step);
		const counts = new Array(variants.length).fill(0) as number[];
		for (const idx of indices) {
			const v = pick(variants, idx);
			const i = variants.indexOf(v);
			counts[i] = (counts[i] ?? 0) + 1;
		}
		const expected = 1000 / variants.length;
		const chi2 = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
		// χ²(df=2, α=0.01) = 9.21
		expect(chi2).toBeLessThan(9.21);
	});
});

// ── formatPrompt 端到端稳定性 ──

describe("formatPrompt 变体端到端", () => {
	const tags = createTagAdapter("default");

	/** 构造一段典型对话：N 轮单工具 exec 调用 */
	function buildConversation(rounds: number): DomainMessage[] {
		const msgs: DomainMessage[] = [
			{ type: "system", content: "You are a helpful assistant." },
			{ type: "generic_user_text", content: "Help me analyze this codebase." },
		];
		for (let r = 0; r < rounds; r++) {
			const callId = `tc_${r}`;
			msgs.push({
				type: "assistant_tool_call",
				content: null,
				reasoning: null,
				reasoningSignature: null,
				toolCalls: [
					{
						id: callId,
						tool: "exec",
						args: { script: `echo round_${r}` },
					},
				],
			});
			msgs.push({
				type: "tool_result",
				tool: "exec",
				status: "completed",
				call: {
					id: callId,
					tool: "exec",
					args: { script: `echo round_${r}` },
				},
				exitCode: 0,
				stdout: `round_${r}`,
				stderr: "",
				durationMs: 10 + r,
			} as DomainMessage);
		}
		return msgs;
	}

	it("追加消息不改变 cache breakpoint 之前的格式化结果（缓存安全）", () => {
		const short = buildConversation(5);
		const long = buildConversation(10);

		const shortResult = formatPrompt(short, tags);
		const longResult = formatPrompt(long, tags);

		// 找 long 结果中的自动 cache breakpoint 位置
		let bpIdx = -1;
		for (let j = longResult.length - 1; j >= 0; j--) {
			if (longResult[j]?.cacheBreakpoint && longResult[j]?.role === "assistant" && longResult[j]?.toolCalls?.length) {
				bpIdx = j;
				break;
			}
		}
		expect(bpIdx).toBeGreaterThan(0);

		// breakpoint 之前的所有消息（不含 breakpoint 自身，因为 short 中该消息的 bp 标记不同）
		// 在 long 中，short 的最后一个 assistant_tool_call 不再是"最后一个"，所以它不再有 cacheBreakpoint。
		// 但 breakpoint 之前的 content/role 应一致。
		// 验证：short 中 cache breakpoint 之前的所有消息，其 content 和 role 在 long 中完全一致。
		const shortBpIdx = shortResult.findIndex(
			(m) => m.cacheBreakpoint && m.role === "assistant" && m.toolCalls?.length,
		);

		// short breakpoint 之前的消息在 long 中内容完全相同
		for (let j = 0; j < shortBpIdx; j++) {
			expect(longResult[j]?.content).toEqual(shortResult[j]?.content);
			expect(longResult[j]?.role).toEqual(shortResult[j]?.role);
		}
	});

	it("cache breakpoint 之前的 tool_result 不包含 system-hint（hint 已剥离）", () => {
		// 构造一个含 diagnostic hint 的对话
		const msgs: DomainMessage[] = [
			{ type: "system", content: "You are helpful." },
			{ type: "generic_user_text", content: "Run something." },
			{
				type: "assistant_tool_call",
				content: null,
				reasoning: null,
				reasoningSignature: null,
				toolCalls: [{ id: "tc_old", tool: "exec", args: { script: "npm run foo" } }],
			},
			{
				type: "tool_result",
				tool: "exec",
				status: "completed",
				call: { id: "tc_old", tool: "exec", args: { script: "npm run foo" } },
				exitCode: 1,
				stdout: "",
				stderr: "Cannot find module 'foo'",
				durationMs: 50,
			} as DomainMessage,
			// 新一轮
			{
				type: "assistant_tool_call",
				content: null,
				reasoning: null,
				reasoningSignature: null,
				toolCalls: [{ id: "tc_new", tool: "exec", args: { script: "echo hi" } }],
			},
			{
				type: "tool_result",
				tool: "exec",
				status: "completed",
				call: { id: "tc_new", tool: "exec", args: { script: "echo hi" } },
				exitCode: 0,
				stdout: "hi",
				stderr: "",
				durationMs: 10,
			} as DomainMessage,
		];

		const result = formatPrompt(msgs, tags);
		const toolResults = result.filter((m) => m.role === "tool");

		// 第一个 tool_result（历史轮）不应含 system-hint
		expect(toolResults[0]?.content).not.toContain("system-hint");
		// 旧行为中本应有 diagnostic_hint，现在被剥离
		expect(toolResults[0]?.content).not.toContain("Package/module not found");
		expect(toolResults[0]?.content).not.toContain("Module resolution failed");
		expect(toolResults[0]?.content).not.toContain("Cannot resolve package");
	});

	it("最新轮的 tool_result 包含 system-hint（当有 hint 时）", () => {
		const msgs: DomainMessage[] = [
			{ type: "system", content: "You are helpful." },
			{ type: "generic_user_text", content: "Run something." },
			{
				type: "assistant_tool_call",
				content: null,
				reasoning: null,
				reasoningSignature: null,
				toolCalls: [{ id: "tc_1", tool: "exec", args: { script: "npm run foo" } }],
			},
			{
				type: "tool_result",
				tool: "exec",
				status: "completed",
				call: { id: "tc_1", tool: "exec", args: { script: "npm run foo" } },
				exitCode: 1,
				stdout: "",
				stderr: "Cannot find module 'foo'",
				durationMs: 50,
			} as DomainMessage,
		];

		const result = formatPrompt(msgs, tags);
		const toolResults = result.filter((m) => m.role === "tool");

		// 最新轮（唯一一轮），应包含 system-hint
		expect(toolResults[0]?.content).toContain("system-hint");
	});

	it("多轮 exec 结果的格式化不完全相同（anti-few-shot）", () => {
		const msgs = buildConversation(10);
		const result = formatPrompt(msgs, tags);

		// 提取所有 tool role 的 content
		const toolContents = result
			.filter((m) => m.role === "tool")
			.map((m) => m.content);

		const unique = new Set(toolContents);
		// 10 条 tool result 不应该全部相同
		expect(unique.size).toBeGreaterThan(1);
	});

	it("多次调用 formatPrompt 结果完全一致（确定性）", () => {
		const msgs = buildConversation(8);
		const first = formatPrompt(msgs, tags);
		for (let repeat = 0; repeat < 10; repeat++) {
			const again = formatPrompt(msgs, tags);
			expect(again).toEqual(first);
		}
	});

	it("自动 cache breakpoint 标记在最后一个含 toolCalls 的 assistant 上", () => {
		const msgs = buildConversation(5);
		const result = formatPrompt(msgs, tags);

		const bpMessages = result.filter((m) => m.cacheBreakpoint && m.role === "assistant" && m.toolCalls?.length);
		expect(bpMessages.length).toBeGreaterThanOrEqual(1);

		// 最后一个有 bp 的 assistant 应该是最后一个 assistant with toolCalls
		const lastAssistantWithTools = result.filter((m) => m.role === "assistant" && m.toolCalls?.length).pop();
		expect(lastAssistantWithTools?.cacheBreakpoint).toBe(true);
	});
});
