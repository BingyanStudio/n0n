/**
 * 渲染逻辑测试 — 验证 redraw 生成的 ANSI 序列正确性
 *
 * 将 reader.ts 中的 redraw 核心逻辑提取为纯函数进行测试，
 * 重点验证 string-width 集成后宽字符的光标定位。
 */
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { InputBuffer } from "../input-buffer.ts";

interface DrawState {
	cursorRow: number;
	totalLines: number;
}

/** 与 reader.ts 中 redraw 逻辑一致的纯函数版本 */
function buildRedrawOutput(
	buf: InputBuffer,
	prev: DrawState,
): { output: string; next: DrawState } {
	let output = "";
	const newTotal = buf.lines.length;

	if (prev.cursorRow > 0) output += `\x1b[${prev.cursorRow}A`;
	output += "\r";

	if (newTotal > prev.totalLines) {
		const extra = newTotal - prev.totalLines;
		const toOldBottom = Math.max(0, prev.totalLines - 1);
		if (toOldBottom > 0) output += `\x1b[${toOldBottom}B`;
		for (let i = 0; i < extra; i++) output += "\n";
		const totalUp = newTotal - 1;
		if (totalUp > 0) output += `\x1b[${totalUp}A`;
		output += "\r";
	}

	output += "\x1b[J";
	for (let i = 0; i < newTotal; i++) {
		if (i > 0) output += "\n";
		output += buf.lines[i]!;
	}

	const up = newTotal - 1 - buf.cursorLine;
	if (up > 0) output += `\x1b[${up}A`;
	output += "\r";
	const dc = stringWidth(buf.lines[buf.cursorLine]!.slice(0, buf.cursorCol));
	if (dc > 0) output += `\x1b[${dc}C`;

	return { output, next: { cursorRow: buf.cursorLine, totalLines: newTotal } };
}

/** 提取输出中最后一个 \x1b[NC 的 N 值（光标右移列数） */
function extractCursorRight(output: string): number {
	const matches = [...output.matchAll(/\x1b\[(\d+)C/g)];
	if (matches.length === 0) return 0;
	return Number.parseInt(matches[matches.length - 1]![1]!, 10);
}

describe("渲染 - 基本状态转换", () => {
	test("初始渲染空行", () => {
		const buf = new InputBuffer();
		const { next } = buildRedrawOutput(buf, { cursorRow: 0, totalLines: 0 });
		expect(next).toEqual({ cursorRow: 0, totalLines: 1 });
	});

	test("单行 ASCII", () => {
		const buf = new InputBuffer();
		buf.insertText("hello");
		const { output, next } = buildRedrawOutput(buf, {
			cursorRow: 0,
			totalLines: 1,
		});
		expect(next).toEqual({ cursorRow: 0, totalLines: 1 });
		expect(extractCursorRight(output)).toBe(5);
	});

	test("两行 → 光标在第二行", () => {
		const buf = new InputBuffer();
		buf.insertText("aaa");
		buf.insertNewline();
		buf.insertText("bb");
		const { next } = buildRedrawOutput(buf, { cursorRow: 0, totalLines: 1 });
		expect(next).toEqual({ cursorRow: 1, totalLines: 2 });
	});

	test("行减少（退格合并）", () => {
		const buf = new InputBuffer();
		buf.insertText("ab");
		buf.insertNewline();
		buf.cursorCol = 0;
		buf.backspace();
		const { next } = buildRedrawOutput(buf, { cursorRow: 1, totalLines: 2 });
		expect(next).toEqual({ cursorRow: 0, totalLines: 1 });
	});

	test("连续 redraw 状态一致性", () => {
		const buf = new InputBuffer();
		let state: DrawState = { cursorRow: 0, totalLines: 0 };

		buf.insertText("hello");
		state = buildRedrawOutput(buf, state).next;
		expect(state).toEqual({ cursorRow: 0, totalLines: 1 });

		buf.insertNewline();
		state = buildRedrawOutput(buf, state).next;
		expect(state).toEqual({ cursorRow: 1, totalLines: 2 });

		buf.insertText("world");
		state = buildRedrawOutput(buf, state).next;
		expect(state).toEqual({ cursorRow: 1, totalLines: 2 });

		buf.moveUp();
		state = buildRedrawOutput(buf, state).next;
		expect(state).toEqual({ cursorRow: 0, totalLines: 2 });
	});
});

describe("渲染 - 宽字符光标定位", () => {
	test("中文字符：光标列 = 显示宽度（每字2列）", () => {
		const buf = new InputBuffer();
		buf.insertText("你好");
		const { output } = buildRedrawOutput(buf, { cursorRow: 0, totalLines: 1 });
		// "你好" 显示宽度 = 4（每个中文 2 列）
		expect(extractCursorRight(output)).toBe(4);
	});

	test("中文光标在中间位置", () => {
		const buf = new InputBuffer();
		buf.insertText("你好世界");
		buf.cursorCol = 2; // "你好" 后面
		const { output } = buildRedrawOutput(buf, { cursorRow: 0, totalLines: 1 });
		expect(extractCursorRight(output)).toBe(4); // "你好" = 4 列
	});

	test("emoji（surrogate pair）：宽度正确", () => {
		const buf = new InputBuffer();
		buf.insertText("a🎉b");
		// cursorCol=4 (a=1cu, 🎉=2cu, b=1cu)
		const { output } = buildRedrawOutput(buf, { cursorRow: 0, totalLines: 1 });
		// "a🎉b" 显示宽度: a=1 + 🎉=2 + b=1 = 4
		expect(extractCursorRight(output)).toBe(4);
	});

	test("emoji 光标在 emoji 前", () => {
		const buf = new InputBuffer();
		buf.insertText("a🎉b");
		buf.cursorCol = 1; // "a" 之后，🎉 之前
		const { output } = buildRedrawOutput(buf, { cursorRow: 0, totalLines: 1 });
		// "a" 显示宽度 = 1
		expect(extractCursorRight(output)).toBe(1);
	});

	test("emoji 光标在 emoji 后", () => {
		const buf = new InputBuffer();
		buf.insertText("a🎉b");
		buf.cursorCol = 3; // "a🎉" 之后，b 之前
		const { output } = buildRedrawOutput(buf, { cursorRow: 0, totalLines: 1 });
		// "a🎉" 显示宽度: 1 + 2 = 3
		expect(extractCursorRight(output)).toBe(3);
	});

	test("混合 ASCII + 中文 + emoji", () => {
		const buf = new InputBuffer();
		buf.insertText("hi你🎉");
		// h(1cu) i(1cu) 你(1cu) 🎉(2cu) = 5 code units
		const { output } = buildRedrawOutput(buf, { cursorRow: 0, totalLines: 1 });
		// 显示宽度: h(1) + i(1) + 你(2) + 🎉(2) = 6
		expect(extractCursorRight(output)).toBe(6);
	});

	test("多行中文第一行光标", () => {
		const buf = new InputBuffer();
		buf.insertText("你好");
		buf.insertNewline();
		buf.insertText("世界");
		buf.moveUp(); // 回到第一行，cursorCol=min(2,2)=2
		const { output } = buildRedrawOutput(buf, { cursorRow: 1, totalLines: 2 });
		// 第一行 "你好" cursorCol=2, 显示宽度=4
		expect(extractCursorRight(output)).toBe(4);
	});

	test("光标在行首时不输出 cursorRight", () => {
		const buf = new InputBuffer();
		buf.insertText("hello");
		buf.cursorCol = 0;
		const { output } = buildRedrawOutput(buf, { cursorRow: 0, totalLines: 1 });
		// 不应有 \x1b[0C 或 \x1b[C
		expect(extractCursorRight(output)).toBe(0);
	});
});
