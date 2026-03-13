/**
 * edit 工具单元测试 — 行号匹配模式
 *
 * 覆盖：正常替换、单行替换、插入（空范围）、边界校验、文件不存在等。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editTool } from "../edit.ts";
import type { EditToolCall } from "@n0n/types";

function makeCall(args: EditToolCall["args"]): EditToolCall {
	return { id: "test-1", tool: "edit", args };
}

describe("editTool (line-based)", () => {
	let workspace: string;
	let testFile: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "edit-test-"));
		testFile = "test.txt";
		writeFileSync(
			join(workspace, testFile),
			["line1", "line2", "line3", "line4", "line5"].join("\n"),
		);
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test("replaces a range of lines", async () => {
		const result = await editTool(
			makeCall({ path: testFile, startLine: 2, endLine: 4, content: "newA\nnewB" }),
			workspace,
		);
		expect(result.success).toBe(true);
		expect(result.replacedCount).toBe(3);
		const content = readFileSync(join(workspace, testFile), "utf8");
		expect(content).toBe("line1\nnewA\nnewB\nline5");
	});

	test("replaces a single line", async () => {
		const result = await editTool(
			makeCall({ path: testFile, startLine: 3, endLine: 3, content: "replaced" }),
			workspace,
		);
		expect(result.success).toBe(true);
		expect(result.replacedCount).toBe(1);
		const content = readFileSync(join(workspace, testFile), "utf8");
		expect(content).toBe("line1\nline2\nreplaced\nline4\nline5");
	});

	test("deletes lines when content is empty", async () => {
		const result = await editTool(
			makeCall({ path: testFile, startLine: 2, endLine: 3, content: "" }),
			workspace,
		);
		expect(result.success).toBe(true);
		expect(result.replacedCount).toBe(2);
		const content = readFileSync(join(workspace, testFile), "utf8");
		expect(content).toBe("line1\nline4\nline5");
	});

	test("replaces first line", async () => {
		const result = await editTool(
			makeCall({ path: testFile, startLine: 1, endLine: 1, content: "new-first" }),
			workspace,
		);
		expect(result.success).toBe(true);
		const content = readFileSync(join(workspace, testFile), "utf8");
		expect(content).toBe("new-first\nline2\nline3\nline4\nline5");
	});

	test("replaces last line", async () => {
		const result = await editTool(
			makeCall({ path: testFile, startLine: 5, endLine: 5, content: "new-last" }),
			workspace,
		);
		expect(result.success).toBe(true);
		const content = readFileSync(join(workspace, testFile), "utf8");
		expect(content).toBe("line1\nline2\nline3\nline4\nnew-last");
	});

	test("replaces entire file", async () => {
		const result = await editTool(
			makeCall({ path: testFile, startLine: 1, endLine: 5, content: "all-new" }),
			workspace,
		);
		expect(result.success).toBe(true);
		expect(result.replacedCount).toBe(5);
		const content = readFileSync(join(workspace, testFile), "utf8");
		expect(content).toBe("all-new");
	});

	test("clamps endLine to file length", async () => {
		const result = await editTool(
			makeCall({ path: testFile, startLine: 4, endLine: 100, content: "clamped" }),
			workspace,
		);
		expect(result.success).toBe(true);
		expect(result.replacedCount).toBe(2); // lines 4-5
		const content = readFileSync(join(workspace, testFile), "utf8");
		expect(content).toBe("line1\nline2\nline3\nclamped");
	});

	// ── Error cases ──

	test("errors when file not found", async () => {
		const result = await editTool(
			makeCall({ path: "nonexistent.txt", startLine: 1, endLine: 1, content: "x" }),
			workspace,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("File not found");
	});

	test("errors when startLine < 1", async () => {
		const result = await editTool(
			makeCall({ path: testFile, startLine: 0, endLine: 1, content: "x" }),
			workspace,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("must be >= 1");
	});

	test("errors when startLine > endLine", async () => {
		const result = await editTool(
			makeCall({ path: testFile, startLine: 3, endLine: 1, content: "x" }),
			workspace,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("must be <=");
	});

	test("errors when startLine exceeds file length", async () => {
		const result = await editTool(
			makeCall({ path: testFile, startLine: 10, endLine: 10, content: "x" }),
			workspace,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("exceeds file length");
	});
});
