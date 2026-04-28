// biome-ignore-all lint/style/noNonNullAssertion: test assertions on known-shape results
/**
 * executeToolStream 单元测试
 *
 * 验证工具调用的流式执行：
 * - 未知工具 → yield ToolArgErrorMessage with kind: "unknown_tool"
 * - 已知工具 → 正常执行
 */

import { describe, expect, it } from "bun:test";
import type { ToolArgErrorMessage, ToolCallRecord } from "@n0n/types";
import type { ToolEntry } from "@n0n/tools";
import { executeToolStream, type GetToolEntry } from "../tool.ts";

// ── 辅助 ──

async function collectStream(
	tc: ToolCallRecord,
	getEntry?: GetToolEntry,
) {
	const events: unknown[] = [];
	for await (const e of executeToolStream(tc, [], undefined, getEntry)) {
		events.push(e);
	}
	return events;
}

/** mock 一个最小可用的 exec tool entry */
function mockExecEntry(): ToolEntry {
	return {
		definition: {
			name: "exec",
			description: "Execute a script",
			parameters: {
				type: "object",
				properties: {
					script: { type: "string" },
					runtime: { type: "string" },
				},
				required: ["script"],
			},
		},
		stream: false,
		execute: async (_tc: any) => ({
			type: "tool_result" as const,
			tool: "exec" as const,
			call: _tc,
			status: "completed" as const,
			exitCode: 0,
			stdout: "mock output",
			stderr: "",
			durationMs: 1,
		}),
	};
}

// ── 测试 ──

describe("executeToolStream", () => {
	describe("未知工具", () => {
		it("应 yield ToolArgErrorMessage with kind: unknown_tool", async () => {
			const tc: ToolCallRecord = {
				id: "call_read",
				tool: "read",
				args: { path: "/tmp/test" },
			} as unknown as ToolCallRecord;

			const events = await collectStream(tc);

			// 不应出现 tool_result
			const results = events.filter((e: any) => e.type === "tool_result");
			expect(results).toHaveLength(0);

			// 应有 tool_arg_error
			const errors = events.filter(
				(e: any) => e.type === "tool_arg_error",
			) as ToolArgErrorMessage[];
			expect(errors).toHaveLength(1);
			expect(errors[0]!.tool).toBe("read");
			expect(errors[0]!.callId).toBe("call_read");
			expect(errors[0]!.error.kind).toBe("unknown_tool");
		});

		it("未知工具错误为纯数据，不含提示词字符串", async () => {
			const tc: ToolCallRecord = {
				id: "call_unknown",
				tool: "delete",
				args: {},
			} as unknown as ToolCallRecord;

			const events = await collectStream(tc);
			const err = events[0] as ToolArgErrorMessage;

			expect(err.error.kind).toBe("unknown_tool");
			// 纯数据：不包含 prompt 文本
			expect(err.error).not.toHaveProperty("message");
		});
	});

	describe("已知工具（有 mock getEntry）", () => {
		it("应正常执行且不报 tool_arg_error", async () => {
			const tc: ToolCallRecord = {
				id: "call_exec",
				tool: "exec",
				args: { script: "echo hello", runtime: "sh" },
			} as unknown as ToolCallRecord;

			const mockEntry = mockExecEntry();
			const getEntry: GetToolEntry = (name) =>
				name === "exec" ? mockEntry : undefined;
			const events = await collectStream(tc, getEntry);

			const argErrors = events.filter(
				(e: any) => e.type === "tool_arg_error",
			);
			expect(argErrors).toHaveLength(0);

			const results = events.filter((e: any) => e.type === "tool_result");
			expect(results).toHaveLength(1);
		});
	});
});
