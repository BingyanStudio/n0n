/**
 * selectCacheBreakpoints 单元测试
 *
 * 验证 Anthropic prompt caching 断点选择策略：
 * - 始终选中最后一条 system 消息
 * - 有多个 user 消息时，倒数第二个 user 获得 anchor（thinking 清空后的稳定边界）
 * - 剩余配额从末尾向前取 non-assistant 消息
 * - 最多 4 个断点
 */

import { describe, expect, test } from "bun:test";
import { selectCacheBreakpoints } from "../cache.ts";

const S = { role: "system" };
const U = { role: "user" };
const A = { role: "assistant" };
const T = { role: "tool" };

describe("selectCacheBreakpoints", () => {
	test("最小序列: S U → system + user", () => {
		const bp = selectCacheBreakpoints([S, U]);
		expect(bp).toContain(0); // system
		expect(bp).toContain(1); // user
		expect(bp.length).toBe(2);
	});

	test("正常轮次(1 user, 3 tools): S U A T A T A T → system + 3 tools", () => {
		const msgs = [S, U, A, T, A, T, A, T];
		const bp = selectCacheBreakpoints(msgs);
		expect(bp).toContain(0); // system
		// 应包含 user@1 和末尾的 tool，共 4 个
		expect(bp.length).toBe(4);
		expect(bp).toContain(7); // 最后一个 T
		expect(bp).toContain(5); // 倒数第二个 T
	});

	test("有 reminder(2 users): S U A T A T A T U → 倒数第二个 user 有 anchor", () => {
		const msgs = [S, U, A, T, A, T, A, T, U];
		const bp = selectCacheBreakpoints(msgs);
		expect(bp).toContain(0); // system
		expect(bp).toContain(1); // 倒数第二个 user（关键！）
		expect(bp).toContain(8); // 最后一个 user (reminder)
		expect(bp).toContain(7); // 最后一个 tool
		expect(bp.length).toBe(4);
	});

	test("多个 reminder(3 users): S U A T U A T U → 倒数第二个 user 有 anchor", () => {
		const msgs = [S, U, A, T, U, A, T, U];
		const bp = selectCacheBreakpoints(msgs);
		expect(bp).toContain(0); // system
		expect(bp).toContain(4); // 倒数第二个 user
		expect(bp).toContain(7); // 最后一个 user
		expect(bp.length).toBe(4);
	});

	test("长会话 + reminder: 确保 prev user 被选中", () => {
		const msgs = [S, U, A, T, A, T, A, T, A, T, A, T, U];
		const bp = selectCacheBreakpoints(msgs);
		expect(bp).toContain(0); // system
		expect(bp).toContain(1); // 倒数第二个 user（prev user）
		expect(bp).toContain(12); // 最后一个 user (reminder)
		expect(bp).toContain(11); // 最后一个 tool
		expect(bp.length).toBe(4);
	});

	test("无 system 消息: 只选 non-assistant", () => {
		const msgs = [U, A, T, A, T];
		const bp = selectCacheBreakpoints(msgs);
		expect(bp).not.toContain(-1);
		// 应选中 user@0, tool@2, tool@4
		expect(bp).toContain(0);
		expect(bp).toContain(4);
		expect(bp.length).toBeLessThanOrEqual(4);
	});

	test("最多 4 个断点", () => {
		// 很多 non-assistant 消息
		const msgs = [S, U, T, T, T, T, T, T, T, T];
		const bp = selectCacheBreakpoints(msgs);
		expect(bp.length).toBeLessThanOrEqual(4);
	});

	test("空消息列表", () => {
		const bp = selectCacheBreakpoints([]);
		expect(bp.length).toBe(0);
	});
});
