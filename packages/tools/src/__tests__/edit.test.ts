/**
 * edit 工具单元测试 — Vim ex 命令模式
 *
 * 覆盖：行删除、范围删除、替换、追加、插入、模式定址、
 *       函数体替换、markdown 章节替换、全局命令、多步编辑、
 *       特殊字符、错误处理。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditToolCall } from "@n0n/types";
import { editTool } from "../edit.ts";

function makeCall(args: EditToolCall["args"]): EditToolCall {
	return { id: "test-1", tool: "edit", args };
}

/** Normalize trailing newline (Vim always adds one) */
function read(dir: string, file: string): string {
	return readFileSync(join(dir, file), "utf8").replace(/\n$/, "");
}

describe("editTool (vim ex commands)", () => {
	let workspace: string;
	const F = "test.txt";

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "vim-edit-test-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	// ── 基础 ex 命令 ──

	test("deletes a single line (:Nd)", async () => {
		writeFileSync(join(workspace, F), "a\nb\nc\nd\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["3d"] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("a\nb\nd");
	});

	test("deletes a line range (:N,Md)", async () => {
		writeFileSync(join(workspace, F), "a\nb\nc\nd\ne\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["2,4d"] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("a\ne");
	});

	test("substitutes on a single line (:Ns/old/new/)", async () => {
		writeFileSync(join(workspace, F), "hello world\nfoo bar\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["1s/hello/goodbye/"] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("goodbye world\nfoo bar");
	});

	test("global substitution (:%s/old/new/g)", async () => {
		writeFileSync(join(workspace, F), "aa bb aa\ncc aa dd\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["%s/aa/XX/g"] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("XX bb XX\ncc XX dd");
	});

	// ── 多行插入/追加/替换 ──

	test("appends after a line (:Na + content + .)", async () => {
		writeFileSync(join(workspace, F), "line1\nline2\nline3\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["2a", "inserted", "."] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("line1\nline2\ninserted\nline3");
	});

	test("inserts before a line (:Ni + content + .)", async () => {
		writeFileSync(join(workspace, F), "line1\nline2\nline3\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["2i", "inserted", "."] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("line1\ninserted\nline2\nline3");
	});

	test("multi-line append", async () => {
		writeFileSync(join(workspace, F), "a\nb\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["1a", "x", "y", "z", "."] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("a\nx\ny\nz\nb");
	});

	// ── 模式定址 ──

	test("deletes line matching pattern (:/pattern/d)", async () => {
		writeFileSync(join(workspace, F), "keep\ndelete me\nkeep too\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["/delete me/d"] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("keep\nkeep too");
	});

	test("deletes range between patterns (:/start/,/end/d)", async () => {
		writeFileSync(join(workspace, F), "before\nSTART\nmid\nEND\nafter\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["/START/,/END/d"] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("before\nafter");
	});

	// ── 代码编辑场景 ──

	test("replaces function body with :change command", async () => {
		const code = [
			"function hello() {",
			"  console.log('old');",
			"  return 1;",
			"}",
			"",
			"function world() {",
			"  return 2;",
			"}",
			"",
		].join("\n");
		writeFileSync(join(workspace, F), code);

		const r = await editTool(
			makeCall({
				path: F,
				commands: [
					"/function hello/+1,/^}/-1c",
					"  console.log('new');",
					"  return 42;",
					".",
				],
			}),
			workspace,
		);
		expect(r.success).toBe(true);
		const result = read(workspace, F);
		expect(result).toContain("console.log('new')");
		expect(result).toContain("return 42");
		expect(result).not.toContain("console.log('old')");
		// world() should be untouched
		expect(result).toContain("function world()");
		expect(result).toContain("return 2");
	});

	// ── Markdown 编辑场景 ──

	test("replaces markdown section content", async () => {
		const md = [
			"# Title",
			"",
			"## Section A",
			"old content",
			"",
			"## Section B",
			"content B",
			"",
		].join("\n");
		writeFileSync(join(workspace, F), md);

		const r = await editTool(
			makeCall({
				path: F,
				commands: [
					"/## Section A/+1,/^## Section B/-1c",
					"new content A",
					"",
					".",
				],
			}),
			workspace,
		);
		expect(r.success).toBe(true);
		const result = read(workspace, F);
		expect(result).toContain("new content A");
		expect(result).not.toContain("old content");
		expect(result).toContain("## Section B");
		expect(result).toContain("content B");
	});

	// ── 全局命令 ──

	test("global delete (:g/pattern/d)", async () => {
		writeFileSync(join(workspace, F), "keep\nTODO: a\nkeep\nTODO: b\nkeep\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["g/TODO/d"] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("keep\nkeep\nkeep");
	});

	// ── 特殊字符 ──

	test("handles $ in replacement without issues", async () => {
		writeFileSync(join(workspace, F), "price = 100\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["1s/100/$200/"] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("price = $200");
	});

	// ── 多步编辑 ──

	test("multi-step: delete then insert", async () => {
		writeFileSync(join(workspace, F), "a\nb\nc\nd\ne\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["2,3d", "1a", "X", "Y", "."] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("a\nX\nY\nd\ne");
	});

	// ── 错误处理 ──

	test("errors when file not found", async () => {
		const r = await editTool(
			makeCall({ path: "nonexistent.txt", commands: ["1d"] }),
			workspace,
		);
		expect(r.success).toBe(false);
		expect(r.error).toContain("File not found");
	});

	test("errors when commands array is empty", async () => {
		writeFileSync(join(workspace, F), "content\n");
		const r = await editTool(makeCall({ path: F, commands: [] }), workspace);
		expect(r.success).toBe(false);
		expect(r.error).toContain("No commands");
	});

	// ── 中文 / UTF-8 多字节字符 ──

	test("substitutes Chinese characters in search pattern", async () => {
		writeFileSync(join(workspace, F), "需要修改的内容\n第二行\n");
		const r = await editTool(
			makeCall({ path: F, commands: ["%s/需要修改/已修改/g"] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("已修改的内容\n第二行");
	});

	test("change command with Chinese content", async () => {
		writeFileSync(join(workspace, F), "function hello() {\n  旧代码\n}\n");
		const r = await editTool(
			makeCall({
				path: F,
				commands: ["/function hello/+1,/^}/-1c", "  新代码", "."],
			}),
			workspace,
		);
		expect(r.success).toBe(true);
		const result = read(workspace, F);
		expect(result).toContain("新代码");
		expect(result).not.toContain("旧代码");
	});

	test("global delete with Chinese pattern", async () => {
		writeFileSync(
			join(workspace, F),
			"保留\n待办: 修复\n保留\n待办: 删除\n保留\n",
		);
		const r = await editTool(
			makeCall({ path: F, commands: ["g/待办/d"] }),
			workspace,
		);
		expect(r.success).toBe(true);
		expect(read(workspace, F)).toBe("保留\n保留\n保留");
	});
});
