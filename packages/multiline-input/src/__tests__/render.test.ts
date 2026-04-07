// biome-ignore-all lint/style/noNonNullAssertion: test assertions on known-shape data
// biome-ignore-all lint/suspicious/noControlCharactersInRegex: ANSI escape parsing requires control chars
/**
 * 渲染逻辑测试 — 验证 redraw 生成的 ANSI 序列正确性
 *
 * 将 reader.ts 中的 redraw 核心逻辑提取为纯函数进行测试，
 * 重点验证 string-width 集成后宽字符的光标定位，
 * 以及折行（超过终端宽度）时的行数计算和光标偏移。
 */
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { InputBuffer } from "../input-buffer.ts";

interface DrawState {
	cursorRow: number;
	totalRows: number;
}

/** 计算一个逻辑行在终端上占用的实际行数 */
function terminalRowsForLine(line: string, cols: number): number {
	const w = stringWidth(line);
	if (w === 0) return 1;
	return Math.ceil(w / cols);
}

/** 计算光标在某逻辑行中的终端行偏移（0-based） */
function cursorTerminalRow(
	line: string,
	cursorCol: number,
	cols: number,
): number {
	const w = stringWidth(line.slice(0, cursorCol));
	return Math.floor(w / cols);
}

/** 计算光标在终端行中的列偏移 */
function cursorTerminalCol(
	line: string,
	cursorCol: number,
	cols: number,
): number {
	const w = stringWidth(line.slice(0, cursorCol));
	return w % cols;
}

/** 与 reader.ts 中 redraw 逻辑一致的纯函数版本 */
function buildRedrawOutput(
	buf: InputBuffer,
	prev: DrawState,
	cols = 80,
): { output: string; next: DrawState } {
	let output = "";

	// 计算新的总终端行数
	let newTotalRows = 0;
	for (let i = 0; i < buf.lines.length; i++) {
		newTotalRows += terminalRowsForLine(buf.lines[i]!, cols);
	}

	// 计算光标所在的终端行
	let newCursorRow = 0;
	for (let i = 0; i < buf.cursorLine; i++) {
		newCursorRow += terminalRowsForLine(buf.lines[i]!, cols);
	}
	newCursorRow += cursorTerminalRow(
		buf.lines[buf.cursorLine]!,
		buf.cursorCol,
		cols,
	);

	// 1) 移到渲染起始行
	if (prev.cursorRow > 0) output += `\x1b[${prev.cursorRow}A`;
	output += "\r";

	// 2) 新增行时先 scroll 终端
	if (newTotalRows > prev.totalRows) {
		const extra = newTotalRows - prev.totalRows;
		const toOldBottom = Math.max(0, prev.totalRows - 1);
		if (toOldBottom > 0) output += `\x1b[${toOldBottom}B`;
		for (let i = 0; i < extra; i++) output += "\n";
		const totalUp = newTotalRows - 1;
		if (totalUp > 0) output += `\x1b[${totalUp}A`;
		output += "\r";
	}

	// 3) clearDown + 重绘
	output += "\x1b[J";
	for (let i = 0; i < buf.lines.length; i++) {
		if (i > 0) output += "\n";
		output += buf.lines[i]!;
	}

	// 4) 定位光标
	const up = newTotalRows - 1 - newCursorRow;
	if (up > 0) output += `\x1b[${up}A`;
	output += "\r";
	const dc = cursorTerminalCol(buf.lines[buf.cursorLine]!, buf.cursorCol, cols);
	if (dc > 0) output += `\x1b[${dc}C`;

	return {
		output,
		next: { cursorRow: newCursorRow, totalRows: newTotalRows },
	};
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
		const { next } = buildRedrawOutput(buf, {
			cursorRow: 0,
			totalRows: 0,
		});
		expect(next).toEqual({ cursorRow: 0, totalRows: 1 });
	});

	test("单行 ASCII", () => {
		const buf = new InputBuffer();
		buf.insertText("hello");
		const { output, next } = buildRedrawOutput(buf, {
			cursorRow: 0,
			totalRows: 1,
		});
		expect(next).toEqual({ cursorRow: 0, totalRows: 1 });
		expect(extractCursorRight(output)).toBe(5);
	});

	test("两行 → 光标在第二行", () => {
		const buf = new InputBuffer();
		buf.insertText("aaa");
		buf.insertNewline();
		buf.insertText("bb");
		const { next } = buildRedrawOutput(buf, {
			cursorRow: 0,
			totalRows: 1,
		});
		expect(next).toEqual({ cursorRow: 1, totalRows: 2 });
	});

	test("行减少（退格合并）", () => {
		const buf = new InputBuffer();
		buf.insertText("ab");
		buf.insertNewline();
		buf.cursorCol = 0;
		buf.backspace();
		const { next } = buildRedrawOutput(buf, {
			cursorRow: 1,
			totalRows: 2,
		});
		expect(next).toEqual({ cursorRow: 0, totalRows: 1 });
	});

	test("连续 redraw 状态一致性", () => {
		const buf = new InputBuffer();
		let state: DrawState = { cursorRow: 0, totalRows: 0 };

		buf.insertText("hello");
		state = buildRedrawOutput(buf, state).next;
		expect(state).toEqual({ cursorRow: 0, totalRows: 1 });

		buf.insertNewline();
		state = buildRedrawOutput(buf, state).next;
		expect(state).toEqual({ cursorRow: 1, totalRows: 2 });

		buf.insertText("world");
		state = buildRedrawOutput(buf, state).next;
		expect(state).toEqual({ cursorRow: 1, totalRows: 2 });

		buf.moveUp();
		state = buildRedrawOutput(buf, state).next;
		expect(state).toEqual({ cursorRow: 0, totalRows: 2 });
	});
});

describe("渲染 - 宽字符光标定位", () => {
	test("中文字符：光标列 = 显示宽度（每字2列）", () => {
		const buf = new InputBuffer();
		buf.insertText("你好");
		const { output } = buildRedrawOutput(buf, {
			cursorRow: 0,
			totalRows: 1,
		});
		// "你好" 显示宽度 = 4（每个中文 2 列）
		expect(extractCursorRight(output)).toBe(4);
	});

	test("中文光标在中间位置", () => {
		const buf = new InputBuffer();
		buf.insertText("你好世界");
		buf.cursorCol = 2; // "你好" 后面
		const { output } = buildRedrawOutput(buf, {
			cursorRow: 0,
			totalRows: 1,
		});
		expect(extractCursorRight(output)).toBe(4); // "你好" = 4 列
	});

	test("emoji（surrogate pair）：宽度正确", () => {
		const buf = new InputBuffer();
		buf.insertText("a🎉b");
		// cursorCol=4 (a=1cu, 🎉=2cu, b=1cu)
		const { output } = buildRedrawOutput(buf, {
			cursorRow: 0,
			totalRows: 1,
		});
		// "a🎉b" 显示宽度: a=1 + 🎉=2 + b=1 = 4
		expect(extractCursorRight(output)).toBe(4);
	});

	test("emoji 光标在 emoji 前", () => {
		const buf = new InputBuffer();
		buf.insertText("a🎉b");
		buf.cursorCol = 1; // "a" 之后，🎉 之前
		const { output } = buildRedrawOutput(buf, {
			cursorRow: 0,
			totalRows: 1,
		});
		// "a" 显示宽度 = 1
		expect(extractCursorRight(output)).toBe(1);
	});

	test("emoji 光标在 emoji 后", () => {
		const buf = new InputBuffer();
		buf.insertText("a🎉b");
		buf.cursorCol = 3; // "a🎉" 之后，b 之前
		const { output } = buildRedrawOutput(buf, {
			cursorRow: 0,
			totalRows: 1,
		});
		// "a🎉" 显示宽度: 1 + 2 = 3
		expect(extractCursorRight(output)).toBe(3);
	});

	test("混合 ASCII + 中文 + emoji", () => {
		const buf = new InputBuffer();
		buf.insertText("hi你🎉");
		// h(1cu) i(1cu) 你(1cu) 🎉(2cu) = 5 code units
		const { output } = buildRedrawOutput(buf, {
			cursorRow: 0,
			totalRows: 1,
		});
		// 显示宽度: h(1) + i(1) + 你(2) + 🎉(2) = 6
		expect(extractCursorRight(output)).toBe(6);
	});

	test("多行中文第一行光标", () => {
		const buf = new InputBuffer();
		buf.insertText("你好");
		buf.insertNewline();
		buf.insertText("世界");
		buf.moveUp(); // 回到第一行，cursorCol=min(2,2)=2
		const { output } = buildRedrawOutput(buf, {
			cursorRow: 1,
			totalRows: 2,
		});
		// 第一行 "你好" cursorCol=2, 显示宽度=4
		expect(extractCursorRight(output)).toBe(4);
	});

	test("光标在行首时不输出 cursorRight", () => {
		const buf = new InputBuffer();
		buf.insertText("hello");
		buf.cursorCol = 0;
		const { output } = buildRedrawOutput(buf, {
			cursorRow: 0,
			totalRows: 1,
		});
		// 不应有 \x1b[0C 或 \x1b[C
		expect(extractCursorRight(output)).toBe(0);
	});
});

describe("渲染 - 折行（超过终端宽度）", () => {
	test("单行刚好等于终端宽度 → 占 1 终端行", () => {
		const buf = new InputBuffer();
		buf.insertText("a".repeat(20));
		const { next } = buildRedrawOutput(buf, { cursorRow: 0, totalRows: 0 }, 20);
		expect(next.totalRows).toBe(1);
	});

	test("单行超过终端宽度 → 占 2 终端行", () => {
		const buf = new InputBuffer();
		buf.insertText("a".repeat(25)); // 25 字符，终端宽度 20
		const { next } = buildRedrawOutput(buf, { cursorRow: 0, totalRows: 0 }, 20);
		expect(next.totalRows).toBe(2);
		// 光标在第二个终端行
		expect(next.cursorRow).toBe(1);
	});

	test("单行超过终端宽度 → 光标列偏移正确", () => {
		const buf = new InputBuffer();
		buf.insertText("a".repeat(25)); // 25 字符，终端宽度 20
		const { output } = buildRedrawOutput(
			buf,
			{ cursorRow: 0, totalRows: 0 },
			20,
		);
		// 光标应在第二终端行的第 5 列 (25 % 20 = 5)
		expect(extractCursorRight(output)).toBe(5);
	});

	test("折行 + 多逻辑行 → 总终端行数正确", () => {
		const buf = new InputBuffer();
		buf.insertText("a".repeat(25)); // 占 2 终端行（cols=20）
		buf.insertNewline();
		buf.insertText("b".repeat(10)); // 占 1 终端行
		const { next } = buildRedrawOutput(buf, { cursorRow: 0, totalRows: 0 }, 20);
		expect(next.totalRows).toBe(3); // 2 + 1
	});

	test("中文折行：每字2列宽", () => {
		const buf = new InputBuffer();
		// 终端宽度 10，每个中文占 2 列，5 个中文 = 10 列 = 1 行
		buf.insertText("你好世界呀"); // 10 列 → 1 行
		const { next: n1 } = buildRedrawOutput(
			buf,
			{ cursorRow: 0, totalRows: 0 },
			10,
		);
		expect(n1.totalRows).toBe(1);

		buf.reset();
		buf.insertText("你好世界呀吗"); // 12 列 → 2 行
		const { next: n2 } = buildRedrawOutput(
			buf,
			{ cursorRow: 0, totalRows: 0 },
			10,
		);
		expect(n2.totalRows).toBe(2);
	});

	test("光标在折行中间位置的终端行偏移", () => {
		const buf = new InputBuffer();
		buf.insertText("a".repeat(50)); // cols=20 → 3 终端行
		buf.cursorCol = 25; // 第 2 终端行的第 5 列
		const { next, output } = buildRedrawOutput(
			buf,
			{ cursorRow: 0, totalRows: 0 },
			20,
		);
		expect(next.totalRows).toBe(3);
		expect(next.cursorRow).toBe(1); // 第 2 个终端行 (0-based)
		expect(extractCursorRight(output)).toBe(5); // 列偏移 25 % 20 = 5
	});

	test("连续 redraw 状态一致性（含折行）", () => {
		const buf = new InputBuffer();
		let state: DrawState = { cursorRow: 0, totalRows: 0 };

		// 输入 25 字符（cols=20），占 2 终端行
		buf.insertText("a".repeat(25));
		state = buildRedrawOutput(buf, state, 20).next;
		expect(state).toEqual({ cursorRow: 1, totalRows: 2 });

		// 换行，新行输入 5 字符
		buf.insertNewline();
		buf.insertText("bbbbb");
		state = buildRedrawOutput(buf, state, 20).next;
		expect(state).toEqual({ cursorRow: 2, totalRows: 3 }); // 2 + 1

		// moveUp 回到第一行末尾（cursorCol 被 clamp 到 25）
		buf.moveUp();
		state = buildRedrawOutput(buf, state, 20).next;
		// 第一行 cursorCol=min(5, 25)=5, 终端行偏移=floor(5/20)=0
		expect(state.cursorRow).toBe(0);
		expect(state.totalRows).toBe(3);
	});
});

describe("渲染 - Tab 对齐", () => {
	/** 模拟 Tab 插入：计算对齐空格数并插入 */
	function insertTab(buf: InputBuffer, tabWidth = 4): void {
		const dc = stringWidth(buf.lines[buf.cursorLine]!.slice(0, buf.cursorCol));
		const spaces = tabWidth - (dc % tabWidth);
		buf.insertText(" ".repeat(spaces));
	}

	test("行首 Tab → 4 空格", () => {
		const buf = new InputBuffer();
		insertTab(buf);
		expect(buf.lines).toEqual(["    "]);
		expect(buf.cursorCol).toBe(4);
	});

	test("1 字符后 Tab → 3 空格（对齐到 4）", () => {
		const buf = new InputBuffer();
		buf.insertText("a");
		insertTab(buf);
		expect(buf.lines).toEqual(["a   "]);
		expect(buf.cursorCol).toBe(4);
	});

	test("3 字符后 Tab → 1 空格（对齐到 4）", () => {
		const buf = new InputBuffer();
		buf.insertText("abc");
		insertTab(buf);
		expect(buf.lines).toEqual(["abc "]);
		expect(buf.cursorCol).toBe(4);
	});

	test("4 字符后 Tab → 4 空格（对齐到 8）", () => {
		const buf = new InputBuffer();
		buf.insertText("abcd");
		insertTab(buf);
		expect(buf.lines).toEqual(["abcd    "]);
		expect(buf.cursorCol).toBe(8);
	});

	test("中文后 Tab 基于显示宽度对齐", () => {
		const buf = new InputBuffer();
		buf.insertText("你"); // 显示宽度 = 2
		insertTab(buf);
		// displayCol = 2, 4 - (2 % 4) = 2 空格
		expect(buf.lines).toEqual(["你  "]);
		const dc = stringWidth(buf.lines[0]!.slice(0, buf.cursorCol));
		expect(dc).toBe(4); // 对齐到 4
	});

	test("连续两次 Tab", () => {
		const buf = new InputBuffer();
		insertTab(buf); // 0 → 4 空格
		insertTab(buf); // 4 → 4 空格
		expect(buf.lines).toEqual(["        "]);
		expect(buf.cursorCol).toBe(8);
	});
});
