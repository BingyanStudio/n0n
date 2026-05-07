// biome-ignore-all lint/style/noNonNullAssertion: test assertions on known-shape results
/**
 * tool-recovery 单元测试
 *
 * 验证截断恢复中的 ToolError kind：
 * - 已知工具 + 恢复失败 → kind: "truncated_recovery"
 * - 未知工具 → kind: "unknown_tool"
 */

import { describe, expect, it } from "bun:test";
import type { ToolCallRecord, DomainMessage, ToolArgErrorMessage } from "@n0n/types";
import {
	type PartialToolCall,
	recoverPartialCalls,
} from "../tool-recovery.ts";

// ── 辅助 ──

function makeTryRecover(knownTools: Set<string>) {
	return async (toolName: string, toolCallId: string, partialJson: string) => {
		if (!knownTools.has(toolName)) return null;
		return {
			call: {
				id: toolCallId,
				tool: toolName,
				args: JSON.parse(partialJson || "{}"),
			} as ToolCallRecord,
			result: {
				type: "tool_result",
				tool: toolName,
				call: { id: toolCallId, tool: toolName, args: {} },
				success: true,
				error: null,
			} as unknown as DomainMessage,
		};
	};
}

// ── 测试 ──

describe("recoverPartialCalls", () => {
	describe("未知工具（不在注册表中）", () => {
		it("应产生 kind: unknown_tool 的 tool_arg_error", async () => {
			const partials: PartialToolCall[] = [
				{
					index: 0,
					toolCallId: "call_001",
					toolName: "read",
					partialInput: '{"path":"file.ts"}',
				},
			];

			const knownTools = new Set(["exec", "write", "edit", "progress"]);
			const result = await recoverPartialCalls(
				partials,
				makeTryRecover(knownTools),
			);

			expect(result.pairs).toHaveLength(1);
			expect(result.pairs[0]!.status).toBe("unrecoverable");

			const err = result.pairs[0]!.result as ToolArgErrorMessage;
			expect(err.type).toBe("tool_arg_error");
			expect(err.error.kind).toBe("unknown_tool");
			expect(err.tool).toBe("read");
		});

		it("未知工具错误为纯数据，不含提示词", async () => {
			const partials: PartialToolCall[] = [
				{
					index: 0,
					toolCallId: "call_002",
					toolName: "delete",
					partialInput: "{}",
				},
			];

			const knownTools = new Set(["exec", "write", "edit", "progress"]);
			const result = await recoverPartialCalls(
				partials,
				makeTryRecover(knownTools),
			);

			const err = result.pairs[0]!.result as ToolArgErrorMessage;
			expect(err.error.kind).toBe("unknown_tool");
			// 纯数据：不包含 prompt 文本字段
			expect(err.error).not.toHaveProperty("message");
		});
	});

	describe("已知工具但恢复失败", () => {
		it("应产生 kind: truncated_recovery 的 tool_arg_error", async () => {
			const partials: PartialToolCall[] = [
				{
					index: 0,
					toolCallId: "call_003",
					toolName: "exec",
					partialInput: '{"script":"ec', // 真正的截断
				},
			];

			const knownTools = new Set(["exec", "write", "edit"]);
			const result = await recoverPartialCalls(
				partials,
				makeTryRecover(knownTools),
			);

			const err = result.pairs[0]!.result as ToolArgErrorMessage;
			expect(err.error.kind).toBe("truncated_recovery");
		});
	});
});
