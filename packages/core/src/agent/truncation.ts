/**
 * truncation — 流式输出截断/中断时的工具调用恢复与消息构建
 *
 * 从 loop.ts 剥离的独立模块。职责：
 * 1. 识别哪些工具调用参数完整、哪些被截断
 * 2. 对截断的 write 工具尝试恢复（提取 path + 部分 content）
 * 3. 构建截断相关的 DomainMessage（tool_call:truncated）
 *
 * 与 loop.ts 的约定：
 * - 输入：StreamAccumulator 中的工具调用状态 + 中断原因
 * - 输出：可执行的补全工具列表 + 截断消息列表
 */

import type {
	ToolCallRecord,
	TruncatedToolCallInfo,
	ToolCallTruncatedMessage,
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
	/** 可补全并入队执行的工具（目前仅 write） */
	recoveredTools: ToolCallRecord[];
	/** 无法恢复的截断工具信息（用于 assistant_tool_call.truncatedCalls） */
	truncatedCalls: TruncatedToolCallInfo[];
	/** 需要 push 到 messages 的截断相关消息 */
	messages: DomainMessage[];
}

/**
 * 分析截断的工具调用，生成恢复结果。
 *
 * @param partials 未完整的工具调用列表
 * @param reason 中断原因
 */
export function analyzeTruncatedCalls(
	partials: PartialToolCall[],
	reason: "length" | "error" | "aborted",
): TruncationResult {
	const recoveredTools: ToolCallRecord[] = [];
	const truncatedCalls: TruncatedToolCallInfo[] = [];
	const messages: DomainMessage[] = [];

	for (const partial of partials) {
		// 过滤无法解析的工具调用
		if (!partial.toolCallId || !partial.toolName) continue;

		// write 特殊处理：尝试从截断 JSON 中恢复 path + content
		if (partial.toolName === "write") {
			const recovered = tryExtractPartialWrite(partial.partialInput);
			if (recovered) {
				recoveredTools.push({
					id: partial.toolCallId,
					tool: "write",
					args: { path: recovered.path, content: recovered.content },
				} as ToolCallRecord);
				// 补全的 write 执行后，push 截断提示（用 tool_call:truncated 类型）
				messages.push({
					type: "tool_call:truncated",
					tool: "write",
					callId: partial.toolCallId,
					reason,
					partialArgs: partial.partialInput,
				});
				continue;
			}
		}

		// 非 write / 无法补全 → 记入 truncatedCalls
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

/**
 * 尝试从截断的 write 工具 JSON 参数中提取 path 和 content。
 *
 * write 的参数格式为 {"path":"...","content":"..."}。
 * 当 content 被 max_tokens 截断时，JSON 不完整，但 path 和部分 content 仍可恢复。
 * 返回 null 表示无法提取（path 未找到）。
 *
 * 注意：当前只处理基础 JSON 转义（\n \t \r \" \\），
 * 未处理 \uXXXX unicode 转义。如果未来遇到相关问题再增加。
 */
export function tryExtractPartialWrite(
	partialJson: string,
): { path: string; content: string } | null {
	const pathMatch = partialJson.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (!pathMatch?.[1]) return null;

	const path = pathMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	if (!path) return null;

	const contentStart = partialJson.indexOf('"content"');
	if (contentStart === -1) return { path, content: "" };

	const valueStart = partialJson.indexOf('"', contentStart + '"content"'.length + 1);
	if (valueStart === -1) return { path, content: "" };

	const rawContent = partialJson.slice(valueStart + 1);
	const cleaned = rawContent.replace(/\\?$/, "");
	const content = cleaned
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\r/g, "\r")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");

	return { path, content };
}
