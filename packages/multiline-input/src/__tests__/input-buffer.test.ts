import { describe, expect, test } from "bun:test";
import { InputBuffer } from "../input-buffer.ts";

describe("InputBuffer 基础操作", () => {
	test("初始状态", () => {
		const buf = new InputBuffer();
		expect(buf.lines).toEqual([""]);
		expect(buf.cursorLine).toBe(0);
		expect(buf.cursorCol).toBe(0);
		expect(buf.getText()).toBe("");
	});

	test("插入字符", () => {
		const buf = new InputBuffer();
		buf.insertText("abc");
		expect(buf.lines).toEqual(["abc"]);
		expect(buf.cursorCol).toBe(3);
	});

	test("插入换行", () => {
		const buf = new InputBuffer();
		buf.insertText("hello");
		buf.insertNewline();
		buf.insertText("world");
		expect(buf.lines).toEqual(["hello", "world"]);
		expect(buf.getText()).toBe("hello\nworld");
	});

	test("行中间插入换行", () => {
		const buf = new InputBuffer();
		buf.insertText("helloworld");
		buf.cursorCol = 5;
		buf.insertNewline();
		expect(buf.lines).toEqual(["hello", "world"]);
		expect(buf.cursorLine).toBe(1);
		expect(buf.cursorCol).toBe(0);
	});

	test("退格删除字符", () => {
		const buf = new InputBuffer();
		buf.insertText("abc");
		buf.backspace();
		expect(buf.lines).toEqual(["ab"]);
	});

	test("退格合并行", () => {
		const buf = new InputBuffer();
		buf.insertText("hello");
		buf.insertNewline();
		buf.insertText("world");
		buf.cursorCol = 0;
		buf.backspace();
		expect(buf.lines).toEqual(["helloworld"]);
		expect(buf.cursorCol).toBe(5);
	});

	test("退格在起始位置无操作", () => {
		const buf = new InputBuffer();
		buf.backspace();
		expect(buf.lines).toEqual([""]);
	});

	test("上下移动", () => {
		const buf = new InputBuffer();
		buf.insertText("aaa");
		buf.insertNewline();
		buf.insertText("bb");
		buf.moveUp();
		expect(buf.cursorLine).toBe(0);
		expect(buf.cursorCol).toBe(2); // min(2, 3)
		buf.moveDown();
		expect(buf.cursorLine).toBe(1);
		expect(buf.cursorCol).toBe(2);
		buf.moveUp();
		buf.moveUp(); // 已在顶部
		expect(buf.cursorLine).toBe(0);
	});

	test("左右移动边界", () => {
		const buf = new InputBuffer();
		buf.insertText("abc");
		buf.moveRight(); // 已在末尾
		expect(buf.cursorCol).toBe(3);
		buf.moveLeft();
		expect(buf.cursorCol).toBe(2);
		buf.cursorCol = 0;
		buf.moveLeft(); // 已在行首
		expect(buf.cursorCol).toBe(0);
	});

	test("粘贴多行文本", () => {
		const buf = new InputBuffer();
		buf.insertText("line1\nline2\nline3");
		expect(buf.lines).toEqual(["line1", "line2", "line3"]);
		expect(buf.cursorLine).toBe(2);
	});

	test("粘贴含空行的文本", () => {
		const buf = new InputBuffer();
		buf.insertText("a\n\nb\n\nc");
		expect(buf.lines).toEqual(["a", "", "b", "", "c"]);
		expect(buf.getText()).toBe("a\n\nb\n\nc");
	});

	test("在已有内容中间粘贴", () => {
		const buf = new InputBuffer();
		buf.insertText("helloworld");
		buf.cursorCol = 5;
		buf.insertText("X\nY");
		expect(buf.lines).toEqual(["helloX", "Yworld"]);
	});

	test("reset", () => {
		const buf = new InputBuffer();
		buf.insertText("a\nb\nc");
		buf.reset();
		expect(buf.lines).toEqual([""]);
		expect(buf.cursorLine).toBe(0);
		expect(buf.cursorCol).toBe(0);
	});
});

describe("InputBuffer surrogate pair / emoji", () => {
	test("插入 emoji（surrogate pair）", () => {
		const buf = new InputBuffer();
		buf.insertText("🎉");
		expect(buf.lines).toEqual(["🎉"]);
		// 🎉 是 surrogate pair，占 2 code units
		expect(buf.cursorCol).toBe(2);
		expect(buf.getText()).toBe("🎉");
	});

	test("插入中文", () => {
		const buf = new InputBuffer();
		buf.insertText("你好世界");
		expect(buf.lines).toEqual(["你好世界"]);
		expect(buf.cursorCol).toBe(4); // 中文在 BMP 内，每个 1 code unit
	});

	test("emoji 后退格正确删除整个 emoji", () => {
		const buf = new InputBuffer();
		buf.insertText("a🎉b");
		expect(buf.cursorCol).toBe(4); // a(1) + 🎉(2) + b(1)
		buf.backspace(); // 删除 b
		expect(buf.lines).toEqual(["a🎉"]);
		expect(buf.cursorCol).toBe(3);
		buf.backspace(); // 删除 🎉（应删 2 code units）
		expect(buf.lines).toEqual(["a"]);
		expect(buf.cursorCol).toBe(1);
	});

	test("emoji 上 moveLeft 跳过整个 surrogate pair", () => {
		const buf = new InputBuffer();
		buf.insertText("a🎉b");
		// cursorCol = 4 (a=1, 🎉=2, b=1)
		buf.moveLeft(); // b→🎉后面，col=3
		expect(buf.cursorCol).toBe(3);
		buf.moveLeft(); // 跳过🎉，col=1
		expect(buf.cursorCol).toBe(1);
		buf.moveLeft(); // col=0
		expect(buf.cursorCol).toBe(0);
	});

	test("emoji 上 moveRight 跳过整个 surrogate pair", () => {
		const buf = new InputBuffer();
		buf.insertText("a🎉b");
		buf.cursorCol = 0;
		buf.moveRight(); // a, col=1
		expect(buf.cursorCol).toBe(1);
		buf.moveRight(); // 🎉, col=3
		expect(buf.cursorCol).toBe(3);
		buf.moveRight(); // b, col=4
		expect(buf.cursorCol).toBe(4);
	});

	test("混合中文和 emoji 的换行", () => {
		const buf = new InputBuffer();
		buf.insertText("你好🎉世界");
		// 你(1) 好(1) 🎉(2) 世(1) 界(1) = 6 code units
		buf.cursorCol = 4; // 你好🎉| 之后
		buf.insertNewline();
		expect(buf.lines).toEqual(["你好🎉", "世界"]);
	});
});
