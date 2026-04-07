/**
 * 缓存锚点滑动行为测试
 *
 * 验证当前 selectCacheBreakpoints 手动管理断点的问题：
 * 断点3-4每轮从末尾向前选取，位置每轮滑动，产生不必要的 cache write。
 *
 * Anthropic 缓存原理（关键）：
 * - 每个 cache_control 断点标记一个前缀缓存检查点
 * - 新增断点时，系统从最近的已缓存前缀开始，写入到新断点位置
 * - cache write 价格是 cache read 的 12.5 倍（Sonnet: write=$3.75, read=$0.30）
 * - 自动缓存（顶层 cache_control）会自动在最后一个可缓存块设断点，
 *   配合 20 块回溯窗口，天然适合只增对话
 */

import { describe, expect, test } from "bun:test";
import { selectCacheBreakpoints } from "../cache.ts";

const S = { role: "system" };
const U = { role: "user" };
const A = { role: "assistant" };
const T = { role: "tool" };

const TOKENS_PER_MSG = 500;

/**
 * 模拟 Anthropic 缓存写入量。
 *
 * 对本轮每个断点，找上一轮缓存中 <= 该位置的最大断点。
 * 差值 × TOKENS_PER_MSG = 该断点的 cache write token 数。
 * 完全匹配则 hit，不写入。
 */
function calcCacheWrite(prev: number[], curr: number[]): number {
	const sorted = [...prev].sort((a, b) => a - b);
	let write = 0;
	for (const bp of curr) {
		let best = -1;
		for (const p of sorted) {
			if (p <= bp) best = p;
		}
		if (best === bp) continue; // hit
		write += (best >= 0 ? bp - best : bp + 1) * TOKENS_PER_MSG;
	}
	return write;
}

function buildConversation(toolRounds: number) {
	const msgs = [S, U];
	for (let i = 0; i < toolRounds; i++) msgs.push(A, T);
	return msgs;
}

describe("缓存锚点滑动分析", () => {
	test("当前策略：断点每轮滑动，cache write 远超增量", () => {
		let prev: number[] = [];
		let totalWrite = 0;
		let totalNewTokens = 0;

		console.log("\n=== 当前策略（手动4断点）===");
		console.log("轮次 | 断点           | write(tok) | 增量(tok)");

		for (let round = 1; round <= 12; round++) {
			const msgs = buildConversation(round);
			const bp = selectCacheBreakpoints(msgs).sort((a, b) => a - b);
			const write = calcCacheWrite(prev, bp);
			const newTokens = round > 1 ? 2 * TOKENS_PER_MSG : msgs.length * TOKENS_PER_MSG;

			totalWrite += write;
			totalNewTokens += newTokens;

			console.log(
				`  ${String(round).padStart(2)}  | [${bp.map(b => String(b).padStart(2)).join(",")}] | ${String(write).padStart(10)} | ${String(newTokens).padStart(9)}`,
			);
			prev = bp;
		}

		console.log(`\n总 cache write: ${totalWrite} tok`);
		console.log(`总增量 token:  ${totalNewTokens} tok`);
		console.log(`write/增量 = ${(totalWrite / totalNewTokens).toFixed(1)}x（理想为 ~1.0x）`);

		// 简单场景（每轮1个 tool call）下差距不大，因为断点恰好能回溯命中
		// 但仍比理想值高（第一轮多写 system）
		expect(totalWrite).toBeGreaterThan(totalNewTokens);
	});

	test("自动缓存策略：只在末尾设断点，write 等于增量", () => {
		// 自动缓存等价于：只在最后一个可缓存块设断点
		// 系统通过20块回溯窗口自动匹配之前的缓存前缀
		function autoBreakpoints(msgs: { role: string }[]): number[] {
			// 最后一条 non-assistant 消息
			for (let i = msgs.length - 1; i >= 0; i--) {
				if (msgs[i]?.role !== "assistant") return [i];
			}
			return [];
		}

		let prev: number[] = [];
		let totalWrite = 0;
		let totalNewTokens = 0;

		console.log("\n=== 自动缓存（末尾单断点）===");
		console.log("轮次 | 断点   | write(tok) | 增量(tok)");

		for (let round = 1; round <= 12; round++) {
			const msgs = buildConversation(round);
			const bp = autoBreakpoints(msgs);
			const write = calcCacheWrite(prev, bp);
			const newTokens = round > 1 ? 2 * TOKENS_PER_MSG : msgs.length * TOKENS_PER_MSG;

			totalWrite += write;
			totalNewTokens += newTokens;

			console.log(
				`  ${String(round).padStart(2)}  | [${bp.map(b => String(b).padStart(2)).join(",")}] | ${String(write).padStart(10)} | ${String(newTokens).padStart(9)}`,
			);
			prev = bp;
		}

		console.log(`\n总 cache write: ${totalWrite} tok`);
		console.log(`总增量 token:  ${totalNewTokens} tok`);
		console.log(`write/增量 = ${(totalWrite / totalNewTokens).toFixed(1)}x（理想为 ~1.0x）`);

		// 自动缓存的 write 应该接近增量
		expect(totalWrite).toBeLessThanOrEqual(totalNewTokens * 1.1);
	});

	test("真实对话模拟：当前策略 vs 自动缓存的开销差距", () => {
		// 模拟真实对话: S U [A T]+ U(reminder) [A T]+
		const fullRoles = "S U A T T A T T A T T T A T A T T A T T U A T T A T A T U A T A T A T A T A T A T"
			.split(" ")
			.map(c => ({ role: c === "S" ? "system" : c === "U" ? "user" : c === "A" ? "assistant" : "tool" }));

		// 每个 assistant 之前是一轮 LLM 调用
		const rounds: { role: string }[][] = [];
		for (let i = 0; i < fullRoles.length; i++) {
			if (fullRoles[i]!.role === "assistant") {
				rounds.push(fullRoles.slice(0, i));
			}
		}

		let prevManual: number[] = [];
		let prevAuto: number[] = [];
		let manualWrite = 0;
		let autoWrite = 0;

		for (const msgs of rounds) {
			const manual = selectCacheBreakpoints(msgs).sort((a, b) => a - b);
			const auto = [msgs.length - 1]; // 最后一条

			manualWrite += calcCacheWrite(prevManual, manual);
			autoWrite += calcCacheWrite(prevAuto, auto);

			prevManual = manual;
			prevAuto = auto;
		}

		console.log("\n=== 真实对话（15轮）===");
		console.log(`手动4断点 cache write: ${manualWrite} tok`);
		console.log(`自动缓存  cache write: ${autoWrite} tok`);
		console.log(`手动策略多出: ${manualWrite - autoWrite} tok (${((manualWrite / autoWrite - 1) * 100).toFixed(0)}%)`);

		expect(manualWrite).toBeGreaterThan(autoWrite);
	});
});
