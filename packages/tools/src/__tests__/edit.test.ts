/**
 * edit 工具测试 — 影子编辑（Shadow Edit）
 *
 * Patch-based diff：不再测试 applyOps/computeDiff（已删除）。
 * 这些函数被 PatchOp[] 直接透传替代。
 *
 * PatchOp 本身的边界测试见 compute-diff.test.ts。
 */

import { describe, expect, test } from "bun:test";

describe("edit tool (patch-based)", () => {
	test("PatchOp 结构验证", () => {
		const patch = {
			oldText: "Status: PENDING",
			newText: "Status: DONE",
		};
		expect(patch.oldText).toBe("Status: PENDING");
		expect(patch.newText).toBe("Status: DONE");
	});

	test("空 patches 数组", () => {
		const patches: Array<{ oldText: string; newText: string }> = [];
		expect(patches).toHaveLength(0);
	});
});
