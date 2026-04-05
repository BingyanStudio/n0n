/**
 * truncation — 流式输出截断时的工具调用恢复
 *
 * ── 当前逻辑 ──
 *
 * 当 LLM 输出被 max_tokens 截断（finishReason=length）或异常中断时，
 * 部分工具调用的 JSON 参数可能不完整。本模块负责：
 * 1. 遍历所有"已开始但未完成"的工具调用（streaming 中 seen 但未 completed 的 index）
 * 2. 对 write 工具尝试恢复：用正则从截断的 JSON 中提取 path + 部分 content，
 *    构造一个合法的 ToolCallRecord 入队执行（文件会被写入已接收到的内容）
 * 3. 对其他工具（exec/edit/reminder/submit），记入 truncatedCalls，
 *    通过 format-prompt 生成错误 tool response 告知模型重试
 *
 * ── 为什么 write 需要特殊处理 ──
 *
 * write 是唯一满足「截断安全」条件的工具：
 * - 参数结构为 { path, content }，path 在 content 之前序列化
 * - content 是纯文本，被截断后仍是合法的前缀（不像 exec 的 script 可能语法不完整）
 * - 写入部分内容 + 后续用 edit 补全 = 比完全丢弃重来更高效
 * - 截断场景几乎只发生在大文件写入（content 字段占用了大量 token），
 *   这恰好是并行执行收益最大的场景（shallow edit 模式下同时写多个文件）
 *
 * ── 已知局限 ──
 *
 * 1. JSON 转义不完整：tryExtractPartialWrite 只处理 \n \t \r \" \\，
 *    未处理 \uXXXX unicode 转义。目前未观测到实际问题。
 * 2. 恢复策略硬编码：只有 write 有恢复路径，未来新工具（如 patch）需要手动添加。
 * 3. 参数字段顺序假设：假设 path 在 content 之前。如果模型以 content-first 序列化，
 *    path 可能出现在截断点之后而无法提取。实测中各主流模型均 path-first。
 * 4. 截断的 write 执行后，模型收到的错误提示是通用文本（format-prompt.ts 中），
 *    未包含已写入的具体行数/字节数，模型需要自行判断从哪里继续。
 *
 * ── 未来演进方向 ──
 *
 * TODO 截断恢复应该是工具自身的能力，而非框架层的 if/else。
 *
 * 理想模式：每个 ToolEntry 声明一个可选的 recover 方法：
 *
 *   interface ToolEntry {
 *     definition: ToolDefinition;
 *     execute: (...) => ...;
 *     // 从截断的 JSON 参数中尝试恢复为可执行的 ToolCallRecord
 *     recover?: (partialJson: string) => ToolCallRecord | null;
 *   }
 *
 * 这样：
 * - write 工具在自己的 ToolEntry 中实现 recover（提取 path + partial content）
 * - edit 工具如果未来支持截断恢复，也在自己的 ToolEntry 中实现
 * - truncation 模块变成一个通用的 for 循环：遍历截断工具 → 调用 entry.recover → 成功则入队
 * - 新增工具时无需修改框架代码，只需在工具定义中提供 recover 即可
 *
 * 迁移路径：
 * 1. 在 ToolEntry 中添加 optional recover 方法
 * 2. 将 tryExtractPartialWrite 移入 write 工具的 recover 实现
 * 3. analyzeTruncatedCalls 改为接收 getEntry 查找函数，遍历调用 entry.recover
 * 4. 删除本模块中的 write 硬编码逻辑
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
