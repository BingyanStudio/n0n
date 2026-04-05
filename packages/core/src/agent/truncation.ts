/**
 * truncation — 流式输出截断时的工具调用恢复
 *
 * ── 当前逻辑 ──
 *
 * 当 LLM 输出被 max_tokens 截断（finishReason=length）或异常中断时，
 * 部分工具调用的 JSON 参数可能不完整。本模块负责：
 * 1. 遍历所有"已开始但未完成"的工具调用（streaming 中 seen 但未 completed 的 index）
 * 2. 对每个截断工具，查找其 ToolEntry.recover 方法尝试恢复
 * 3. 恢复成功 → 入队执行 + 生成截断提示消息
 * 4. 恢复失败 → 记入 truncatedCalls + 生成错误消息告知模型重试
 *
 * ── 设计原则 ──
 *
 * 截断恢复是工具自身的能力，不是框架的 if/else。
 * 每个 ToolEntry 可声明 optional recover 方法。本模块只做通用遍历。
 * 目前仅 write 工具实现了 recover（截断安全：path-first + content 是合法前缀）。
 *
 * ── 已知局限 ──
 *
 * 1. recover 的输入仅为 partialJson 字符串，无法传递更多上下文
 * 2. 截断的 write 执行后，模型收到的错误提示是通用文本（format-prompt.ts 中），
 *    未包含已写入的具体行数/字节数，模型需要自行判断从哪里继续
 */

import type {
	ToolCallRecord,
	TruncatedToolCallInfo,
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

/** 截断分析的输出 */
export interface TruncationResult {
	/** 可补全并入队执行的工具 */
	recoveredTools: ToolCallRecord[];
	/** 无法恢复的截断工具信息（用于 assistant_tool_call.truncatedCalls） */
	truncatedCalls: TruncatedToolCallInfo[];
	/** 需要 push 到 messages 的截断相关消息 */
	messages: DomainMessage[];
}

/**
 * 尝试恢复截断工具调用的函数签名。
 * 由调用方（round.ts）从 toolkit.getEntry 构造并传入。
 */
export type TryRecoverFn = (
	toolName: string,
	toolCallId: string,
	partialJson: string,
) => ToolCallRecord | null;

/**
 * 分析截断的工具调用，生成恢复结果。
 *
 * @param partials 未完整的工具调用列表
 * @param reason 中断原因
 * @param tryRecover 可选的恢复函数，由工具注册表提供
 */
export function analyzeTruncatedCalls(
	partials: PartialToolCall[],
	reason: "length" | "error" | "aborted",
	tryRecover?: TryRecoverFn,
): TruncationResult {
	const recoveredTools: ToolCallRecord[] = [];
	const truncatedCalls: TruncatedToolCallInfo[] = [];
	const messages: DomainMessage[] = [];

	for (const partial of partials) {
		if (!partial.toolCallId || !partial.toolName) continue;

		// 尝试通过工具自身的 recover 恢复
		const recovered = tryRecover?.(
			partial.toolName,
			partial.toolCallId,
			partial.partialInput,
		);

		if (recovered) {
			recoveredTools.push(recovered);
			messages.push({
				type: "tool_call:truncated",
				tool: partial.toolName,
				callId: partial.toolCallId,
				reason,
				partialArgs: partial.partialInput,
			});
			continue;
		}

		// 无法恢复 → 记入 truncatedCalls
		truncatedCalls.push({
			id: partial.toolCallId,
			tool: partial.toolName,
			partialArgs: partial.partialInput,
		});
		messages.push({
			type: "tool_call:truncated",
			tool: partial.toolName,
			callId: partial.toolCallId,
			reason,
			partialArgs: partial.partialInput,
		});
	}

	return { recoveredTools, truncatedCalls, messages };
}
