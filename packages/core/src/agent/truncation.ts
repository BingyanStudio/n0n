/**
 * truncation — 流式输出截断时的工具调用恢复
 *
 * 当 LLM 输出被 max_tokens 截断或异常中断时，部分工具调用的 JSON 参数可能不完整。
 * 本模块对每个截断工具逐一处理：
 *
 * - 工具名/ID 都解析不出来 → 跳过（当这个工具没有被调用过）
 * - 能识别工具 →
 *   - 有 recover 函数 → 调用 recover（恢复参数+执行），拿到 call + result
 *   - 无 recover 函数 → 生成 tool_arg_error 作为 result
 *
 * 输出统一为 (call, result) 对的列表。loop 不需要关心具体工具类型。
 *
 * TODO 命名歧义：本模块名 "truncation" 描述的是原因（截断），而非职责（恢复）。
 * 应重命名为 "recovery" 或 "tool-recovery"，函数 analyzeTruncatedCalls → recoverPartialCalls。
 */

import type {
	ToolCallRecord,
	DomainMessage,
} from "@n0n/types";

/** 截断分析的输入：某个工具调用的累积状态 */
export interface PartialToolCall {
	index: number;
	toolCallId: string;
	toolName: string;
	/** 已接收的部分 JSON 参数 */
	partialInput: string;
}

/** 单个截断工具的恢复结果：call（放入 assistant 消息）+ result（放入 history） */
export interface RecoveredPair {
	call: ToolCallRecord;
	result: DomainMessage;
}

/** 截断分析的输出 */
export interface TruncationResult {
	/** 所有截断工具的 (call, result) 对 — 无论恢复成功还是失败 */
	pairs: RecoveredPair[];
}

/**
 * 截断恢复函数签名（由工具注册表提供）。
 * 恢复+执行，返回 {call, result} 或 null（恢复失败）。
 */
export type TryRecoverFn = (
	toolName: string,
	toolCallId: string,
	partialJson: string,
) => Promise<{ call: ToolCallRecord; result: DomainMessage } | null>;

/**
 * 分析截断的工具调用，逐一恢复并执行。
 *
 * @param partials 未完整的工具调用列表
 * @param tryRecover 可选的恢复函数，由工具注册表提供
 */
export async function analyzeTruncatedCalls(
	partials: PartialToolCall[],
	tryRecover?: TryRecoverFn,
): Promise<TruncationResult> {
	const pairs: RecoveredPair[] = [];

	for (const partial of partials) {
		if (!partial.toolCallId || !partial.toolName) continue;

		const recovered = await tryRecover?.(
			partial.toolName,
			partial.toolCallId,
			partial.partialInput,
		);

		if (recovered) {
			// recover 成功：拿到 call + result（工具已执行）
			pairs.push(recovered);
		} else {
			// recover 失败：生成空 args 的占位 call + tool_arg_error result
			const placeholderCall: ToolCallRecord = {
				id: partial.toolCallId,
				tool: partial.toolName,
				args: {},
			} as ToolCallRecord;
			pairs.push({
				call: placeholderCall,
				result: {
					type: "tool_arg_error",
					callId: partial.toolCallId,
					tool: partial.toolName,
					error: "Tool call arguments were truncated by max_tokens and could not be recovered. Please retry with a shorter response, or break the task into smaller steps.",
				},
			});
		}
	}

	return { pairs };
}
