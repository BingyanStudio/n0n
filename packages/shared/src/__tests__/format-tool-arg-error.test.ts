// biome-ignore-all lint/style/noNonNullAssertion: test assertions on known-shape results
// biome-ignore-all lint/suspicious/noExplicitAny: test mocks use any for flexibility
/**
 * format-tool-arg-error 单元测试
 *
 * 验证 ToolError 判别联合 → 提示词的格式化：
 * - unknown_tool → 包含工具名和可用工具列表
 * - invalid_args → 包含校验问题描述
 * - truncated_recovery → 包含截断相关提示
 * - internal_error → 包含错误消息
 */

import { describe, expect, it } from "bun:test";
import type { TagAdapter, ToolArgErrorMessage } from "@n0n/types";
import { formatToolArgError } from "../format-prompt/format-tool-arg-error.ts";

// TagAdapter mock
const tags: TagAdapter = {
	wrapTag: (name: string, content: string) => `<${name}>\n${content}\n</${name}>`,
	adaptTags: (content: string) => content,
};

function makeMsg(error: ToolArgErrorMessage["error"], tool = "test_tool"): ToolArgErrorMessage {
	return {
		type: "tool_arg_error",
		callId: "call_01",
		tool,
		error,
	};
}

describe("formatToolArgError", () => {
	describe("unknown_tool", () => {
		it("应包含工具名和可用工具列表", () => {
			const result = formatToolArgError(
				makeMsg({ kind: "unknown_tool" }, "read"),
				tags,
				0,
			);

			expect(result).toContain("read");
			expect(result).toContain("exec");
			expect(result).toContain("write");
			expect(result).toContain("edit");
		});

		it("anti-few-shot：不同 index 产生不同表述", () => {
			const r0 = formatToolArgError(
				makeMsg({ kind: "unknown_tool" }, "read"),
				tags,
				0,
			);
			const r1 = formatToolArgError(
				makeMsg({ kind: "unknown_tool" }, "read"),
				tags,
				1,
			);
			expect(r0).not.toBe(r1);
		});
	});

	describe("invalid_args", () => {
		it("应包含校验问题", () => {
			const result = formatToolArgError(
				makeMsg({
					kind: "invalid_args",
					issues: [{ path: "script", message: "Required" }],
				}, "exec"),
				tags,
				0,
			);

			expect(result).toContain("Required");
			expect(result).toContain("script");
		});

		it("有 schema 时应包含 JSON Schema", () => {
			const result = formatToolArgError(
				makeMsg({
					kind: "invalid_args",
					issues: [{ path: "script", message: "Required" }],
					schema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] },
				}, "exec"),
				tags,
				0,
			);

			expect(result).toContain("Expected schema");
			expect(result).toContain('"script"');
		});
	});

	describe("truncated_recovery", () => {
		it("应包含截断相关提示", () => {
			const result = formatToolArgError(
				makeMsg({ kind: "truncated_recovery" }, "exec"),
				tags,
				0,
			);

			expect(result).toContain("truncated");
		});
	});

	describe("internal_error", () => {
		it("应包含错误消息", () => {
			const result = formatToolArgError(
				makeMsg({ kind: "internal_error", message: "something broke" }, "exec"),
				tags,
				0,
			);

			expect(result).toContain("something broke");
		});
	});
});
