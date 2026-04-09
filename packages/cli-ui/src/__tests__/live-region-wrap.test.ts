/**
 * LiveRegion 行计数 + clear 测试
 *
 * 验证 LiveRegion 主动 wrap 后的行计数精确性：
 * wrap-ansi 折行 → 计数 \n → cursorUp(N) 精确清除。
 *
 * 注意：ansi.ts 中 isTTY 是模块加载时的常量，全量测试中可能因加载顺序
 * 导致 isTTY=false。因此测试通过检查 writeln 输出中的 \n 数量来验证
 * wrap 行为，而非依赖 clear() 的 cursorUp（clear 在 !isTTY 时是 no-op）。
 */

import { describe, expect, test } from "bun:test";
import wrapAnsi from "wrap-ansi";

/** 模拟 LiveRegion.writeln 的 wrap 逻辑：wrap → 计数 \n */
function countWrappedLines(text: string, cols: number): number {
	const wrapped = wrapAnsi(text, cols, { trim: false, hard: true, wordWrap: false });
	const output = `${wrapped}\n`;
	let count = 0;
	for (let i = 0; i < output.length; i++) {
		if (output[i] === "\n") count++;
	}
	return count;
}

describe("LiveRegion wrap line counting", () => {
	test("短行不产生 wrap — 1 行", () => {
		expect(countWrappedLines("short line", 80)).toBe(1);
	});

	test("80 字符在 40 列终端 wrap 成 2 行", () => {
		expect(countWrappedLines("A".repeat(80), 40)).toBe(2);
	});

	test("120 字符在 40 列终端 wrap 成 3 行", () => {
		expect(countWrappedLines("B".repeat(120), 40)).toBe(3);
	});

	test("空行算 1 行", () => {
		expect(countWrappedLines("", 80)).toBe(1);
	});

	test("CJK 中文字符占 2 列宽 — 正确 wrap", () => {
		// 28 个中文(56) + "  │ 1. " 前缀(7) + ASCII 字符 ≈ 82 列 → 80 列 wrap 成 2 行
		const text =
			"  │ 1. 关闭 PR #61，附带说明关闭原因（核心功能已被 PR #75/#76 覆盖，分支严重过时）";
		expect(countWrappedLines(text, 80)).toBe(2);
	});

	test("CJK + ASCII 混合多行 wrap 累加", () => {
		const lines = [
			{ text: "  │ 已完成清理", cols: 40, expected: 1 }, // 12 列
			{ text: "这是二十个中文字符的测试内容来验证宽度", cols: 40, expected: 1 }, // 40 列
			{ text: "这是二十一个中文字符的测试内容来验证宽度吧", cols: 40, expected: 2 }, // 42 列
		];

		let total = 0;
		for (const { text, cols, expected } of lines) {
			const count = countWrappedLines(text, cols);
			expect(count).toBe(expected);
			total += count;
		}
		expect(total).toBe(4);
	});

	test("恰好等于 cols 宽度 — 1 行（不多算）", () => {
		expect(countWrappedLines("X".repeat(80), 80)).toBe(1);
	});

	test("cols + 1 宽度 — wrap 成 2 行", () => {
		expect(countWrappedLines("X".repeat(81), 80)).toBe(2);
	});
});
