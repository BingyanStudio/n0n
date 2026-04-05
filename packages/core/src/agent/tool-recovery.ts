/**
 * tool-recovery — 流式输出截断时的工具调用恢复
 *
 * 当 LLM 输出被 max_tokens 截断或异常中断时，部分工具调用的 JSON 参数可能不完整。
 * 本模块对每个截断工具逐一恢复并执行：
 *
 * - 工具名/ID 都解析不出来 → 跳过（当这个工具没有被调用过）
 * - 能识别工具 →
 *   - 有 recover 函数 → 调用 recover（恢复参数+执行），拿到 call + result
 *   - 无 recover 函数 → 生成 tool_arg_error 作为 result
 *
 * 输出统一为 (call, result) 对的列表。loop 不需要关心具体工具类型。
 */

import type {
	ToolCallRecord,
	PartialToolCallRecord,
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

/** 恢复成功：call 是完整的 ToolCallRecord，result 是工具执行结果 */
export interface RecoveredCall {
	status: "recovered";
	call: ToolCallRecord;
	result: DomainMessage;
}

/** 恢复失败：call 是占位记录（仅 id/tool 有效，args 无意义），result 是 tool_arg_error */
export interface UnrecoverableCall {
	status: "unrecoverable";
	/** 占位 call — 仅 id 和 tool 字段有意义，args 为空对象。
	 *  用于保持 assistant_tool_call 消息结构与 tool_arg_error result 的配对完整性。 */
	call: PartialToolCallRecord;
	result: DomainMessage;
}

/** 单个截断工具的恢复结果 — 判别联合 */
export type RecoveredPair = RecoveredCall | UnrecoverableCall;

/** 截断恢复的输出 */
export interface RecoveryResult {
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
 * 恢复截断的工具调用，逐一尝试恢复并执行。
 *
 * 对每个截断工具：
 * - 有 tryRecover 且恢复成功 → 使用恢复后的 call + result
 * - 恢复失败或无 tryRecover → 生成占位 call + tool_arg_error result
 *
 * @param partials 未完整的工具调用列表
 * @param tryRecover 可选的恢复函数，由工具注册表提供
 */
export async function recoverPartialCalls(
	partials: PartialToolCall[],
	tryRecover?: TryRecoverFn,
): Promise<RecoveryResult> {
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
			pairs.push({ status: "recovered", ...recovered });
		} else {
			// recover 失败：生成占位 call + tool_arg_error result
			// 占位 call 仅用于保持 assistant_tool_call 消息结构完整性。
			// 对应的 tool_arg_error result 会告知模型此调用失败。
			const placeholderCall = {
				id: partial.toolCallId,
				tool: partial.toolName,
				args: {} as Record<string, never>,
			};
			pairs.push({
				status: "unrecoverable",
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
