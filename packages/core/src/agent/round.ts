/**
 * round — 单轮后处理：纯函数集合
 *
 * streaming + 执行完成后，将结果映射为 DomainMessage[]。
 * 每个函数都是 input → output 的纯映射，无副作用。
 */

import type {
	AssistantToolCallMessage,
	DomainMessage,
	PartialToolCallRecord,
	StreamAccumulator,
	ToolCallRecord,
} from "@n0n/types";
import type { PipelineJob } from "./scheduler.ts";
import type { StreamingResult } from "./streaming.ts";
import {
	type PartialToolCall,
	type RecoveryResult,
	recoverPartialCalls,
	type TryRecoverFn,
} from "./tool-recovery.ts";

// ── 截断恢复 ──

/** 从 streaming 结果中提取未完成的工具调用，委托 tool-recovery 模块恢复并执行 */
export async function recoverTruncatedCalls(
	result: StreamingResult,
	tryRecover?: TryRecoverFn,
): Promise<RecoveryResult> {
	const partials: PartialToolCall[] = [];
	const acc = result.accumulator;

	for (const [idx, tcAcc] of acc.toolCalls) {
		if (result.readyTools.has(idx)) continue; // 已完成的跳过
		if (!tcAcc.toolCallId || !tcAcc.toolName) continue;
		partials.push({
			index: idx,
			toolCallId: tcAcc.toolCallId,
			toolName: tcAcc.toolName,
			partialInput: tcAcc.input,
		});
	}

	return recoverPartialCalls(partials, tryRecover);
}

// ── 消息构建 ──

/** 构建 assistant_tool_call 消息 */
export function buildToolCallMessage(
	acc: StreamAccumulator,
	toolCalls: (ToolCallRecord | PartialToolCallRecord)[],
): AssistantToolCallMessage {
	return {
		type: "assistant_tool_call",
		content: acc.content || null,
		reasoning: acc.reasoning || undefined,
		reasoningSignature: acc.reasoningSignature || undefined,
		toolCalls,
	};
}

/** 从 scheduler 完成的 jobs 中收集 domain messages（结果 + 错误） */
export function collectJobMessages(
	jobs: readonly PipelineJob[],
): DomainMessage[] {
	const msgs: DomainMessage[] = [];
	for (const job of jobs) {
		switch (job.status) {
			case "completed":
				msgs.push(job.result);
				break;
			case "failed":
				msgs.push(job.argError);
				break;
			case "pending":
			case "running":
				break;
			default: {
				const _exhaustive: never = job;
				break;
			}
		}
	}
	return msgs;
}

