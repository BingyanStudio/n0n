/**
 * PatchOp 结构 + 边界条件测试
 *
 * 验证场景：
 * - 空 patches → formatPatches 返回 "(no changes)"
 * - 单 patch → newText 正确输出
 * - 多 patches → 用 \n...\n 分隔
 * - 纯删除（空 newText）→ 被 filter 过滤
 */

import { describe, expect, it } from "bun:test";
import type { PatchOp } from "@n0n/types";

// ── 辅助函数（从 format-edit.ts 提取，便于测试） ──

function formatPatches(patches: PatchOp[]): string {
	if (patches.length === 0) return "(no changes)";
	return patches
		.map((p) => p.newText)
		.filter((t) => t.length > 0)
		.join("\n...\n");
}

function countAdded(patches: PatchOp[]): number {
	return patches.reduce(
		(s, p) => s + (p.newText === "" ? 0 : p.newText.split("\n").length),
		0,
	);
}

function countRemoved(patches: PatchOp[]): number {
	return patches.reduce(
		(s, p) => s + (p.oldText === "" ? 0 : p.oldText.split("\n").length),
		0,
	);
}

describe("PatchOp", () => {
	// ── formatPatches ──

	it("空 patches → (no changes)", () => {
		expect(formatPatches([])).toBe("(no changes)");
	});

	it("单 patch → newText 直接输出", () => {
		const patches: PatchOp[] = [
			{ oldText: "old", newText: "new content" },
		];
		expect(formatPatches(patches)).toBe("new content");
	});

	it("多 patches → 用 ... 分隔", () => {
		const patches: PatchOp[] = [
			{ oldText: "a", newText: "first" },
			{ oldText: "b", newText: "second" },
		];
		expect(formatPatches(patches)).toBe("first\n...\nsecond");
	});

	it("纯删除 patch → 被 filter 过滤", () => {
		const patches: PatchOp[] = [
			{ oldText: "remove me", newText: "" },
			{ oldText: "keep", newText: "visible" },
		];
		expect(formatPatches(patches)).toBe("visible");
	});

	it("全部纯删除 → 等同于 (no changes)（全部被过滤）", () => {
		const patches: PatchOp[] = [
			{ oldText: "line1", newText: "" },
			{ oldText: "line2", newText: "" },
		];
		expect(formatPatches(patches)).toBe("");
	});

	// ── countAdded / countRemoved ──

	it("单行插入 → added=1, removed=0", () => {
		const patches: PatchOp[] = [
			{ oldText: "b\nc", newText: "b\nX\nc" },
		];
		expect(countAdded(patches)).toBe(3);
		expect(countRemoved(patches)).toBe(2);
	});

	it("单行删除 → added=0, removed=1", () => {
		const patches: PatchOp[] = [
			{ oldText: "X", newText: "" },
		];
		expect(countAdded(patches)).toBe(0);
		expect(countRemoved(patches)).toBe(1);
	});

	it("多行替换 → 各自计数", () => {
		const patches: PatchOp[] = [
			{ oldText: "a\nb\nc", newText: "x\ny" },
		];
		expect(countAdded(patches)).toBe(2);
		expect(countRemoved(patches)).toBe(3);
	});

	it("空 oldText 和空 newText → 不计数", () => {
		const patches: PatchOp[] = [
			{ oldText: "", newText: "inserted" },
			{ oldText: "deleted", newText: "" },
		];
		expect(countAdded(patches)).toBe(1);
		expect(countRemoved(patches)).toBe(1);
	});

	// ── 真实场景模拟 ──

	it("import 块中插入 1 行", () => {
		const patches: PatchOp[] = [
			{
				oldText: "\tDomainMessage,\n\tPartialToolCallRecord,",
				newText: "\tDomainMessage,\n\tTokenUsage,\n\tPartialToolCallRecord,",
			},
		];
		const formatted = formatPatches(patches);
		expect(formatted).toContain("TokenUsage,");
		expect(formatted).toContain("DomainMessage,");
		expect(formatted).toContain("PartialToolCallRecord,");
		expect(countAdded(patches)).toBe(3);
		expect(countRemoved(patches)).toBe(2);
	});

	it("多步操作保留独立操作边界", () => {
		const patches: PatchOp[] = [
			{ oldText: "readFile(path)", newText: "readFileSync(path, 'utf8')" },
			{
				oldText: "  return data;\n}",
				newText: "  try {\n    return JSON.parse(data);\n  } catch {\n    return data;\n  }\n}",
			},
		];
		const formatted = formatPatches(patches);
		expect(formatted).toContain("readFileSync");
		expect(formatted).toContain("JSON.parse");
		// 两个操作之间用 ... 分隔
		expect(formatted).toContain("\n...\n");
	});
});
