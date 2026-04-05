/**
 * round — 单轮后处理：纯函数集合
 *
 * streaming + 执行完成后，将结果映射为 DomainMessage[]。
 * 每个函数都是 input → output 的纯映射，无副作用。
 */

import type {
	AssistantToolCallMessage,
	DomainMessage,
	ToolCallRecord,
	TruncatedToolCallInfo,
} from "@n0n/types";
import type { StreamAccumulator } from "@n0n/types";
import type { PipelineJob } from "./scheduler.ts";
import {
	analyzeTruncatedCalls,
	type PartialToolCall,
	type TryRecoverFn,
} from "./truncation.ts";
import type { StreamingResult } from "./streaming.ts";

// ── 截断分析 ──

/** 从 streaming 结果中提取未完成的工具调用，委托 truncation 模块分析 */
export function recoverTruncatedCalls(result: StreamingResult, tryRecover?: TryRecoverFn) {
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

	return analyzeTruncatedCalls(partials, result.interrupt ?? "length", tryRecover);
}

// ── 消息构建 ──

/** 构建 assistant_tool_call 消息 */
export function buildToolCallMessage(
	acc: StreamAccumulator,
	executedTools: ToolCallRecord[],
	truncatedCalls?: TruncatedToolCallInfo[],
): AssistantToolCallMessage {
	return {
		type: "assistant_tool_call",
		content: acc.content || null,
		reasoning: acc.reasoning || undefined,
		reasoningSignature: acc.reasoningSignature || undefined,
		toolCalls: executedTools,
		truncatedCalls: truncatedCalls?.length ? truncatedCalls : undefined,
	};
}

/** 从 scheduler 完成的 jobs 中收集 domain messages（结果 + 错误） */
export function collectJobMessages(jobs: readonly PipelineJob[]): DomainMessage[] {
	const msgs: DomainMessage[] = [];
	for (const job of jobs) {
		if (job.argError) msgs.push(job.argError);
		else if (job.result) msgs.push(job.result);
	}
	return msgs;
}

// ── Submit 检查 ──

import type { ZodType } from "zod";
import { toJSONSchema } from "zod";

export interface SubmitCheckResult {
	/** submit 校验通过的值 */
	accepted?: { value: unknown; report: string | null };
	/** submit 校验失败的错误 */
	rejected?: { error: string; retries: number };
	/** 已达最大重试次数 */
	gaveUp?: { error: string };
}

export function checkSubmit<T>(
	jobs: readonly PipelineJob[],
	schema: ZodType<T> | undefined,
	currentRetries: number,
	maxRetries: number,
): SubmitCheckResult {
	for (const job of jobs) {
		if (!job.result || job.result.tool !== "submit") continue;

		if (!schema) {
			return {
				accepted: {
					value: job.result.cleanedResult as T,
					report: job.result.call.args.report ?? null,
				},
			};
		}

		const parsed = schema.safeParse(job.result.cleanedResult);
		if (parsed.success) {
			return {
				accepted: {
					value: parsed.data,
					report: job.result.call.args.report ?? null,
				},
			};
		}

		const issues = parsed.error.issues
			.map((i) => `  ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		let fullSchema: string;
		try {
			fullSchema = JSON.stringify(toJSONSchema(schema), null, 2);
		} catch {
			fullSchema = "(schema serialization failed)";
		}
		const error = `Result does not match expected schema:\n${issues}\n\nFull expected schema:\n${fullSchema}`;

		const retries = currentRetries + 1;
		if (retries >= maxRetries) {
			return { gaveUp: { error } };
		}
		return { rejected: { error, retries } };
	}

	return {}; // 没有 submit 调用
}
