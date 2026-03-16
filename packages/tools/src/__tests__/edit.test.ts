/**
 * edit 工具测试 — 影子编辑（Shadow Edit）
 *
 * 测试纯函数部分：applyOps（search/replace 应用）和 computeDiff（变更摘要）。
 * editTool 集成测试需要 mock LLM，单独标记。
 */

import { describe, expect, test } from "bun:test";
import { applyOps, computeDiff } from "../edit.ts";

// ── applyOps 测试 ──

describe("applyOps", () => {
	test("单次替换", () => {
		const source = "const TIMEOUT = 5000;\nconsole.log('hello');";
		const ops = [{ search: "const TIMEOUT = 5000;", replace: "const TIMEOUT = 10000;" }];
		const result = applyOps(source, ops);
		expect(result.applied).toBe(1);
		expect(result.errors).toHaveLength(0);
		expect(result.content).toBe("const TIMEOUT = 10000;\nconsole.log('hello');");
	});

	test("多次替换（不同位置）", () => {
		const source = "let a = 1;\nlet b = 2;\nlet c = 3;";
		const ops = [
			{ search: "let a = 1;", replace: "let a = 10;" },
			{ search: "let c = 3;", replace: "let c = 30;" },
		];
		const result = applyOps(source, ops);
		expect(result.applied).toBe(2);
		expect(result.errors).toHaveLength(0);
		expect(result.content).toBe("let a = 10;\nlet b = 2;\nlet c = 30;");
	});

	test("删除（replace 为空字符串）", () => {
		const source = "line1\nline2\nline3";
		const ops = [{ search: "line2\n", replace: "" }];
		const result = applyOps(source, ops);
		expect(result.applied).toBe(1);
		expect(result.content).toBe("line1\nline3");
	});

	test("插入（search 包含锚点，replace 包含新内容）", () => {
		const source = "import { writeFile } from 'fs';";
		const ops = [{
			search: "import { writeFile } from 'fs';",
			replace: "import { writeFile } from 'fs';\nimport { readFile } from 'fs/promises';",
		}];
		const result = applyOps(source, ops);
		expect(result.applied).toBe(1);
		expect(result.content).toContain("readFile");
	});

	test("搜索文本不存在 → 报错", () => {
		const source = "hello world";
		const ops = [{ search: "goodbye", replace: "hi" }];
		const result = applyOps(source, ops);
		expect(result.applied).toBe(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("not found");
	});

	test("搜索文本匹配多处 → 报错", () => {
		const source = "let x = 1;\nlet x = 1;";
		const ops = [{ search: "let x = 1;", replace: "let x = 2;" }];
		const result = applyOps(source, ops);
		expect(result.applied).toBe(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("multiple");
	});

	test("部分操作失败不影响其他操作", () => {
		const source = "let a = 1;\nlet b = 2;";
		const ops = [
			{ search: "let a = 1;", replace: "let a = 10;" },
			{ search: "nonexistent", replace: "whatever" },
		];
		const result = applyOps(source, ops);
		expect(result.applied).toBe(1);
		expect(result.errors).toHaveLength(1);
		expect(result.content).toContain("let a = 10;");
	});

	test("空操作列表", () => {
		const source = "hello";
		const result = applyOps(source, []);
		expect(result.applied).toBe(0);
		expect(result.content).toBe("hello");
	});

	test("多行搜索和替换", () => {
		const source = "function foo() {\n  return 1;\n}";
		const ops = [{
			search: "function foo() {\n  return 1;\n}",
			replace: "function foo() {\n  return 42;\n}",
		}];
		const result = applyOps(source, ops);
		expect(result.applied).toBe(1);
		expect(result.content).toContain("return 42;");
	});

	test("中文内容替换", () => {
		const source = "const msg = '你好世界';";
		const ops = [{ search: "你好世界", replace: "你好，新世界" }];
		const result = applyOps(source, ops);
		expect(result.applied).toBe(1);
		expect(result.content).toBe("const msg = '你好，新世界';");
	});

	test("连续替换：第二次操作基于第一次的结果", () => {
		const source = "aaa bbb ccc";
		const ops = [
			{ search: "aaa", replace: "xxx" },
			{ search: "xxx bbb", replace: "yyy" },
		];
		const result = applyOps(source, ops);
		expect(result.applied).toBe(2);
		expect(result.content).toBe("yyy ccc");
	});
});

// ── computeDiff 测试 ──

describe("computeDiff", () => {
	test("无变化", () => {
		const content = "line1\nline2\nline3";
		const diff = computeDiff(content, content, "test.ts");
		expect(diff).toBe("(no changes)");
	});

	test("单行修改 — 只显示最终状态", () => {
		const old = "line1\nline2\nline3";
		const now = "line1\nmodified\nline3";
		const diff = computeDiff(old, now, "test.ts");
		// 应该包含新内容，带 + 前缀
		expect(diff).toContain("+");
		expect(diff).toContain("modified");
		// 不应该包含旧内容的删除标记
		expect(diff).not.toContain("-line2");
		expect(diff).not.toContain("- ");
	});

	test("新增行 — 显示新增内容", () => {
		const old = "line1\nline2";
		const now = "line1\nnew line\nline2";
		const diff = computeDiff(old, now, "test.ts");
		expect(diff).toContain("new line");
		expect(diff).toContain("+");
	});

	test("删除行 — 不显示被删除的内容", () => {
		const old = "line1\nline2\nline3";
		const now = "line1\nline3";
		const diff = computeDiff(old, now, "test.ts");
		// 不应该显示被删除的 line2
		expect(diff).not.toContain("line2");
	});

	test("包含行号和文件路径", () => {
		const old = "line1\nline2\nline3";
		const now = "line1\nchanged\nline3";
		const diff = computeDiff(old, now, "src/foo.ts");
		expect(diff).toContain("src/foo.ts");
		expect(diff).toContain("@@");
	});
});
