/**
 * VirtualTerminal 自身的正确性测试
 */
import { describe, expect, test } from "bun:test";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("VirtualTerminal 基础", () => {
	test("普通文本写入", () => {
		const vt = new VirtualTerminal(40, 10);
		vt.feed("hello world");
		expect(vt.getLine(0)).toBe("hello world");
		expect(vt.cursorRow).toBe(0);
		expect(vt.cursorCol).toBe(11);
	});

	test("换行", () => {
		const vt = new VirtualTerminal(40, 10);
		vt.feed("line1\nline2\n");
		expect(vt.getLine(0)).toBe("line1");
		expect(vt.getLine(1)).toBe("line2");
		expect(vt.cursorRow).toBe(2);
	});

	test("自动换行 — ASCII", () => {
		const vt = new VirtualTerminal(10, 10);
		vt.feed("ABCDEFGHIJKLM"); // 13 chars in 10-col terminal
		expect(vt.getLine(0)).toBe("ABCDEFGHIJ"); // 前 10 个
		expect(vt.getLine(1)).toBe("KLM"); // wrap 到下一行
	});

	test("自动换行 — CJK 全角", () => {
		const vt = new VirtualTerminal(10, 10);
		// 每个中文占 2 列，10 列终端放 5 个
		vt.feed("一二三四五六");
		expect(vt.getLine(0)).toBe("一二三四五");
		expect(vt.getLine(1)).toBe("六");
	});

	test("CJK 字符在行尾放不下时换行", () => {
		const vt = new VirtualTerminal(11, 10);
		// 11 列：5 个中文占 10 列，剩 1 列放不下第 6 个中文（需要 2 列）
		vt.feed("一二三四五六");
		expect(vt.getLine(0)).toBe("一二三四五");
		expect(vt.getLine(1)).toBe("六");
	});

	test("cursor up + clear down", () => {
		const vt = new VirtualTerminal(40, 10);
		vt.feed("line1\nline2\nline3\n");
		// 光标在第3行
		expect(vt.cursorRow).toBe(3);
		// cursor up 2
		vt.feed("\x1b[2A");
		expect(vt.cursorRow).toBe(1);
		// clear down (J without param = 0 = from cursor to end)
		vt.feed("\x1b[J");
		expect(vt.getLine(0)).toBe("line1");
		expect(vt.getLine(1)).toBe(""); // 已清除
		expect(vt.getLine(2)).toBe(""); // 已清除
	});

	test("ANSI 颜色序列不影响位置", () => {
		const vt = new VirtualTerminal(40, 10);
		vt.feed("\x1b[31mred\x1b[0m normal");
		expect(vt.getLine(0)).toBe("red normal");
		expect(vt.cursorCol).toBe(10);
	});

	test("clear line (2K) + cursor to col 0 (0G)", () => {
		const vt = new VirtualTerminal(40, 10);
		vt.feed("old content");
		vt.feed("\x1b[2K\x1b[0G"); // clear line + cursor to start
		vt.feed("new");
		expect(vt.getLine(0)).toBe("new");
	});

	test("模拟 LiveRegion clear+rewrite 循环", () => {
		const vt = new VirtualTerminal(40, 10);
		// 第一次写入 2 行
		vt.feed("streaming line 1\n");
		vt.feed("streaming line 2\n");
		// LiveRegion.clear(): cursorUp(2) + clearDown
		vt.feed("\x1b[2A\x1b[J");
		// 重写 3 行（内容增长）
		vt.feed("updated line 1\n");
		vt.feed("updated line 2\n");
		vt.feed("updated line 3\n");
		expect(vt.getLine(0)).toBe("updated line 1");
		expect(vt.getLine(1)).toBe("updated line 2");
		expect(vt.getLine(2)).toBe("updated line 3");
		// 不应有残留
		expect(vt.getVisibleLines().length).toBe(3);
	});
});
