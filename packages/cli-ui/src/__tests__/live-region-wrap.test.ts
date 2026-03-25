/**
 * LiveRegion 终端自动换行(wrap)行计数测试
 *
 * 验证 LiveRegion 在计算行数时正确考虑了终端列宽导致的自动换行，
 * 确保 clear() 能完全清除所有已写入的内容。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// 捕获 stderr 输出和 ANSI 控制序列
let output: string[];
const originalWrite = process.stderr.write;
const originalColumns = process.stderr.columns;
const originalIsTTY = process.stderr.isTTY;

function setupMock(columns: number) {
	output = [];
	Object.defineProperty(process.stderr, "isTTY", {
		value: true,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(process.stderr, "columns", {
		value: columns,
		writable: true,
		configurable: true,
	});

	// @ts-ignore
	process.stderr.write = function (chunk: string | Uint8Array) {
		if (typeof chunk === "string") {
			output.push(chunk);
		}
		return true;
	};
}

function teardownMock() {
	process.stderr.write = originalWrite;
	Object.defineProperty(process.stderr, "columns", {
		value: originalColumns,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(process.stderr, "isTTY", {
		value: originalIsTTY,
		writable: true,
		configurable: true,
	});
}

// 提取 cursorUp 的行数
function extractCursorUp(captured: string[]): number {
	for (const s of captured) {
		const match = s.match(/\x1b\[(\d+)A/);
		if (match) return Number(match[1]);
	}
	return 0;
}

describe("LiveRegion wrap-aware line counting", () => {
	afterEach(() => {
		teardownMock();
	});

	test("短行不产生 wrap — cursorUp 等于换行符数量", async () => {
		setupMock(80);
		// 动态 import 以获取 mock 后的模块
		const { LiveRegion } = await import("../live-region.ts");
		const region = new LiveRegion();

		region.writeln("short line");
		region.writeln("another");

		output = [];
		region.clear();

		const upCount = extractCursorUp(output);
		expect(upCount).toBe(2);
	});

	test("长行超过终端列宽时 wrap — cursorUp 应大于换行符数量", async () => {
		setupMock(40); // 40列宽的终端
		const { LiveRegion } = await import("../live-region.ts");
		const region = new LiveRegion();

		// 写入一行 80 字符的内容（在 40 列终端中 wrap 成 2 行）
		region.writeln("A".repeat(80));

		output = [];
		region.clear();

		const upCount = extractCursorUp(output);
		expect(upCount).toBe(2); // 80/40 = 2 行
	});

	test("120 字符在 40 列终端中 wrap 成 3 行", async () => {
		setupMock(40);
		const { LiveRegion } = await import("../live-region.ts");
		const region = new LiveRegion();

		region.writeln("B".repeat(120));

		output = [];
		region.clear();

		const upCount = extractCursorUp(output);
		expect(upCount).toBe(3); // ceil(120/40) = 3
	});

	test("多行混合：短行+长行", async () => {
		setupMock(40);
		const { LiveRegion } = await import("../live-region.ts");
		const region = new LiveRegion();

		region.writeln("short");      // 1 行
		region.writeln("C".repeat(80)); // 2 行 (wrap)
		region.writeln("medium text"); // 1 行

		output = [];
		region.clear();

		const upCount = extractCursorUp(output);
		expect(upCount).toBe(4); // 1 + 2 + 1 = 4
	});

	test("空行算 1 行", async () => {
		setupMock(80);
		const { LiveRegion } = await import("../live-region.ts");
		const region = new LiveRegion();

		region.writeln("");
		region.writeln("text");
		region.writeln("");

		output = [];
		region.clear();

		const upCount = extractCursorUp(output);
		expect(upCount).toBe(3);
	});
});
