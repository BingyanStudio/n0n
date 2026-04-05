/**
 * round 纯函数单元测试
 *
 * 验证单轮后处理的各函数：
 * - recoverTruncatedCalls：从 streaming 结果中识别截断工具，委托 tool-recovery 模块恢复并执行
 * - buildToolCallMessage：构建 assistant_tool_call 消息
 * - collectJobMessages：从 scheduler jobs 收集 domain messages
 * - checkSubmit：submit 校验（无 schema / 有 schema / 重试 / 超限）
 */

import { describe, expect, it } from "bun:test";
import { StreamAccumulator } from "@n0n/types";
import type { ToolCallRecord, ToolResult, SubmitToolResult, DomainMessage } from "@n0n/types";
import type { PipelineJob } from "../scheduler.ts";
import type { StreamingResult } from "../streaming.ts";
import {
	recoverTruncatedCalls,
	buildToolCallMessage,
	collectJobMessages,
	checkSubmit,
} from "../round.ts";
import { z } from "zod";

// ── 辅助 ──

function makeAccWithToolCalls(
	tools: Array<{ index: number; id: string; name: string; input: string }>,
): StreamAccumulator {
	const acc = new StreamAccumulator();
	for (const t of tools) {
		acc.push({
			type: "tool_call_delta",
			index: t.index,
			id: t.id,
			name: t.name,
			arguments: t.input,
		});
	}
	return acc;
}

function mockJob(tc: ToolCallRecord, result: ToolResult | null, argError?: any): PipelineJob {
	return {
		tc,
		done: true,
		result: result,
		argError: argError ?? null,
		events: [],
	} as unknown as PipelineJob;
}

function mockSubmitResult(cleanedResult: unknown, report?: string): SubmitToolResult {
	return {
		type: "tool_result",
		tool: "submit",
		call: { id: "sub_1", tool: "submit", args: { result: cleanedResult, report: report ?? null } },
		cleanedResult,
	} as SubmitToolResult;
}

function mockExecTC(id: string): ToolCallRecord {
	return { id, tool: "exec", args: { script: "ls" } } as ToolCallRecord;
}

function mockExecResult(tc: ToolCallRecord): ToolResult {
	return {
		type: "tool_result",
		tool: "exec",
		call: tc,
		status: "completed",
		exitCode: 0,
		stdout: "output",
		stderr: "",
		durationMs: 100,
	} as ToolResult;
}

// ── recoverTruncatedCalls ──

describe("recoverTruncatedCalls", () => {
	it("无截断工具 → 空 pairs", async () => {
		const acc = makeAccWithToolCalls([
			{ index: 0, id: "tc_1", name: "exec", input: '{"script":"ls"}' },
		]);
		const readyTools = new Map<number, ToolCallRecord>();
		readyTools.set(0, { id: "tc_1", tool: "exec", args: { script: "ls" } } as ToolCallRecord);

		const result = await recoverTruncatedCalls({
			accumulator: acc,
			readyTools,
			interrupt: null,
		});

		expect(result.pairs).toHaveLength(0);
	});

	it("截断的非 write 工具（无 recover）→ 占位 call + tool_arg_error", async () => {
		const acc = makeAccWithToolCalls([
			{ index: 0, id: "tc_1", name: "exec", input: '{"scri' },
		]);

		const result = await recoverTruncatedCalls({
			accumulator: acc,
			readyTools: new Map(),
			interrupt: "length",
		});

		expect(result.pairs).toHaveLength(1);
		expect(result.pairs[0]!.status).toBe("unrecoverable");
		expect(result.pairs[0]!.call.tool).toBe("exec");
		expect(result.pairs[0]!.call.args as any).toEqual({});
		expect(result.pairs[0]!.result.type).toBe("tool_arg_error");
	});

	it("截断的 write 工具（有 recover）→ 恢复+执行", async () => {
		const acc = makeAccWithToolCalls([
			{ index: 0, id: "tc_1", name: "write", input: '{"path":"test.ts","content":"partial con' },
		]);

		// 模拟 recover：恢复参数 + 执行 → 返回 {call, result}
		const tryRecover = async (toolName: string, toolCallId: string, _partialJson: string) => {
			if (toolName !== "write") return null;
			const call = { id: toolCallId, tool: "write", args: { path: "test.ts", content: "partial con" } } as ToolCallRecord;
			const result: DomainMessage = {
				type: "tool_result",
				tool: "write",
				call: call as any,
				status: "recovered",
			} as any;
			return { call, result };
		};

		const result = await recoverTruncatedCalls({
			accumulator: acc,
			readyTools: new Map(),
			interrupt: "length",
		}, tryRecover);

		expect(result.pairs).toHaveLength(1);
		expect(result.pairs[0]!.status).toBe("recovered");
		expect(result.pairs[0]!.call.tool).toBe("write");
		expect((result.pairs[0]!.call.args as any).path).toBe("test.ts");
		expect(result.pairs[0]!.result.type).toBe("tool_result");
	});
});

// ── buildToolCallMessage ──

describe("buildToolCallMessage", () => {
	it("构建包含工具调用的 assistant 消息", () => {
		const acc = new StreamAccumulator();
		acc.push({ type: "content", text: "Let me do this" });
		acc.push({ type: "thinking", text: "reasoning" });

		const tc: ToolCallRecord = { id: "tc_1", tool: "exec", args: { script: "ls" } } as ToolCallRecord;
		const msg = buildToolCallMessage(acc, [tc]);

		expect(msg.type).toBe("assistant_tool_call");
		expect(msg.content).toBe("Let me do this");
		expect(msg.reasoning).toBe("reasoning");
		expect(msg.toolCalls).toHaveLength(1);
		expect(msg.toolCalls[0]!.id).toBe("tc_1");
	});
});

// ── collectJobMessages ──

describe("collectJobMessages", () => {
	it("收集正常结果", () => {
		const tc = mockExecTC("tc_1");
		const result = mockExecResult(tc);
		const jobs = [mockJob(tc, result)];

		const msgs = collectJobMessages(jobs);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]!.type).toBe("tool_result");
	});

	it("收集参数错误", () => {
		const tc = mockExecTC("tc_1");
		const argError = { type: "tool_arg_error", callId: "tc_1", tool: "exec", error: "bad args" };
		const jobs = [mockJob(tc, null, argError)];

		const msgs = collectJobMessages(jobs);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]!.type).toBe("tool_arg_error");
	});

	it("空 jobs → 空消息", () => {
		expect(collectJobMessages([])).toHaveLength(0);
	});

	it("多个 jobs 按顺序收集", () => {
		const tc1 = mockExecTC("tc_1");
		const tc2 = mockExecTC("tc_2");
		const jobs = [
			mockJob(tc1, mockExecResult(tc1)),
			mockJob(tc2, mockExecResult(tc2)),
		];

		const msgs = collectJobMessages(jobs);
		expect(msgs).toHaveLength(2);
	});
});

// ── checkSubmit ──

describe("checkSubmit", () => {
	it("无 submit 调用 → 空结果", () => {
		const tc = mockExecTC("tc_1");
		const jobs = [mockJob(tc, mockExecResult(tc))];
		const result = checkSubmit(jobs, undefined, 0, 4);
		expect(result.accepted).toBeUndefined();
		expect(result.rejected).toBeUndefined();
		expect(result.gaveUp).toBeUndefined();
	});

	it("无 schema → 直接 accepted", () => {
		const submitTc = { id: "sub_1", tool: "submit", args: { result: { answer: 42 }, report: "done" } } as ToolCallRecord;
		const submitResult = mockSubmitResult({ answer: 42 }, "done");
		const jobs = [mockJob(submitTc, submitResult)];

		const result = checkSubmit(jobs, undefined, 0, 4);
		expect(result.accepted).toBeDefined();
		expect(result.accepted!.value).toEqual({ answer: 42 });
		expect(result.accepted!.report).toBe("done");
	});

	it("有 schema，校验通过 → accepted", () => {
		const schema = z.object({ answer: z.number() });
		const submitTc = { id: "sub_1", tool: "submit", args: { result: { answer: 42 } } } as ToolCallRecord;
		const submitResult = mockSubmitResult({ answer: 42 });
		const jobs = [mockJob(submitTc, submitResult)];

		const result = checkSubmit(jobs, schema, 0, 4);
		expect(result.accepted).toBeDefined();
		expect(result.accepted!.value).toEqual({ answer: 42 });
	});

	it("有 schema，校验失败 → rejected", () => {
		const schema = z.object({ answer: z.number() });
		const submitTc = { id: "sub_1", tool: "submit", args: { result: { answer: "not a number" } } } as ToolCallRecord;
		const submitResult = mockSubmitResult({ answer: "not a number" });
		const jobs = [mockJob(submitTc, submitResult)];

		const result = checkSubmit(jobs, schema, 0, 4);
		expect(result.rejected).toBeDefined();
		expect(result.rejected!.retries).toBe(1);
		expect(result.rejected!.error).toContain("schema");
	});

	it("重试次数达到上限 → gaveUp", () => {
		const schema = z.object({ answer: z.number() });
		const submitTc = { id: "sub_1", tool: "submit", args: { result: { answer: "bad" } } } as ToolCallRecord;
		const submitResult = mockSubmitResult({ answer: "bad" });
		const jobs = [mockJob(submitTc, submitResult)];

		const result = checkSubmit(jobs, schema, 3, 4);
		expect(result.gaveUp).toBeDefined();
		expect(result.gaveUp!.error).toContain("schema");
	});
});
