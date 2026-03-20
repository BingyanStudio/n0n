/**
 * DomainMessage ↔ AI SDK ModelMessage 转换
 *
 * 领域消息是结构化数据记录，这里负责转换为 AI SDK 需要的 ModelMessage 格式。
 * 所有输出统一为 XML + Markdown 混合结构：
 * - XML 标签划分内容边界，便于模型理解结构
 * - 标签内部为纯文本 / Markdown，无需 XML 转义
 *
 * 支持 Anthropic prompt caching：通过 providerOptions 注入 cache_control。
 */

import type {
	ModelMessage,
	AssistantModelMessage,
	ToolModelMessage,
} from "ai";
import type {
	DomainMessage,
	EditDiff,
	EditToolResult,
	ExecToolResult,
	ToolResult,
	WriteToolResult,
} from "@n0n/types";
import { adaptTags, wrapTag } from "./tags.ts";

/* ── tool result 格式化 ── */

function formatExecResult(msg: ExecToolResult, model: string): string {
	const meta = `[${msg.call.args.runtime ?? "unknown"}] [cwd: ${msg.call.args.cwd ?? "."}] [exit: ${msg.exitCode}] [${msg.durationMs}ms]`;
	const parts = [wrapTag("exec_meta", meta, model)];
	if (msg.stdout) parts.push(wrapTag("stdout", msg.stdout, model));
	if (msg.stderr) parts.push(wrapTag("stderr", msg.stderr, model));
	return parts.join("\n");
}

function formatWriteResult(msg: WriteToolResult, model: string): string {
	if (msg.success) {
		return wrapTag(
			"write_result",
			`Written to \`${msg.call.args.path}\``,
			model,
		);
	}
	return wrapTag("error", `Write failed: ${msg.error}`, model);
}

function formatDiffText(diff: EditDiff): string {
	if (diff.chunks.length === 0) return "(no changes)";
	const sections: string[] = [];
	for (const chunk of diff.chunks) {
		const body = chunk.lines.map((dl) => dl.content).join("\n");
		sections.push(body);
	}
	return sections.join("\n...\n");
}

function formatEditResult(msg: EditToolResult, model: string): string {
	const parts: string[] = [];
	if (msg.success) {
		const summary = `Edited \`${msg.call.args.path}\`:\n${formatDiffText(msg.diff)}`;
		parts.push(wrapTag("edit_result", summary, model));
	} else {
		parts.push(wrapTag("error", `Edit failed: ${msg.error}`, model));
	}
	if (msg.feedback) {
		parts.push(wrapTag("edit_feedback", msg.feedback, model));
	}
	return parts.join("\n");
}

function toolResultToContent(msg: ToolResult, model: string): string {
	switch (msg.call.tool) {
		case "exec":
			return formatExecResult(msg as ExecToolResult, model);
		case "write":
			return formatWriteResult(msg as WriteToolResult, model);
		case "edit":
			return formatEditResult(msg as EditToolResult, model);
		case "reminder": {
			const delay = msg.call.args.delay ?? 7;
			return wrapTag(
				"result",
				`Reminder set. Commitment: ${delay} rounds. A <reminder> will be injected when it expires.`,
				model,
			);
		}
		case "submit": {
			const parts = [wrapTag("result", "Submitted successfully.", model)];
			if ("userResponse" in msg && msg.userResponse) {
				parts.push(wrapTag("user_response", msg.userResponse, model));
			}
			return parts.join("\n");
		}
	}
}

/* ── Prompt Caching 注解 ── */

/**
 * 为 Anthropic prompt caching 创建 providerOptions
 *
 * Anthropic 支持在消息级别标记 cache_control: { type: "ephemeral" }，
 * 让 API 缓存该消息之前的所有 token，后续请求直接复用。
 *
 * 缓存策略：标记 system prompt 和第一条 user message 作为稳定的缓存前缀。
 */
function anthropicCacheControl(): {
	anthropic: { cacheControl: { type: "ephemeral" } };
} {
	return { anthropic: { cacheControl: { type: "ephemeral" } } };
}

/* ── 主转换函数 ── */

/**
 * DomainMessage[] → ModelMessage[]
 *
 * @param providerType - provider 类型，用于注入 provider-specific 选项（如 Anthropic cache_control）
 */
export function toAPIMessages(
	messages: DomainMessage[],
	model: string,
	providerType?: string,
): ModelMessage[] {
	const result: ModelMessage[] = [];
	const isAnthropic = providerType === "anthropic";
	let systemCount = 0;
	let userCount = 0;

	for (const msg of messages) {
		switch (msg.type) {
			case "system": {
				systemCount++;
				const sysMsg: ModelMessage = {
					role: "system",
					content: adaptTags(msg.content, model),
					...(isAnthropic ? { providerOptions: anthropicCacheControl() } : {}),
				};
				result.push(sysMsg);
				break;
			}

			case "user_text": {
				userCount++;
				const userMsg: ModelMessage = {
					role: "user",
					content: msg.content,
					// 第一条 user message 作为缓存断点
					...(isAnthropic && userCount === 1
						? { providerOptions: anthropicCacheControl() }
						: {}),
				};
				result.push(userMsg);
				break;
			}

			case "user_image":
				result.push({
					role: "user",
					content: `[Image: ${msg.imagePath}] ${msg.text}`,
				});
				break;

			case "assistant_text": {
				const assistantMsg: AssistantModelMessage = {
					role: "assistant",
					content: msg.content,
				};
				result.push(assistantMsg);
				break;
			}

			case "assistant_tool_call": {
				const assistantMsg: AssistantModelMessage = {
					role: "assistant",
					content: [
						// 文本内容（如果有）
						...(msg.content ? [{ type: "text" as const, text: msg.content }] : []),
						// tool calls → ToolCallPart
						...msg.toolCalls.map((tc) => ({
							type: "tool-call" as const,
							toolCallId: tc.id,
							toolName: tc.tool,
							input: tc.args,
						})),
					],
				};
				result.push(assistantMsg);
				break;
			}

			case "tool_result": {
				const toolMsg: ToolModelMessage = {
					role: "tool",
					content: [
						{
							type: "tool-result" as const,
							toolCallId: msg.call.id,
							toolName: msg.call.tool,
							output: {
								type: "text" as const,
								value: toolResultToContent(msg, model),
							},
						},
					],
				};
				result.push(toolMsg);
				break;
			}

			case "idle_nudge":
				result.push({
					role: "user",
					content: wrapTag(
						"system_warning",
						`You replied with plain text without using any tools. You MUST use tools to make progress. Idle ${msg.idleCount}/${msg.maxIdleRounds}.`,
						model,
					),
				});
				break;

			case "reminder:due":
				result.push({
					role: "user",
					content: wrapTag(
						"reminder",
						`Your reminder fired (set ${msg.originalDelay} rounds ago):\n${msg.content}`,
						model,
					),
				});
				break;

			case "submit:rejected":
				result.push({
					role: "user",
					content: wrapTag(
						"submit_rejected",
						`Submit rejected (attempt ${msg.attempt}/${msg.maxAttempts}): ${msg.error}`,
						model,
					),
				});
				break;

			case "user_input":
				result.push({
					role: "user",
					content: buildUserInputContent(msg, model),
				});
				break;

			case "turn_feedback":
				result.push({
					role: "user",
					content: wrapTag(
						"turn_feedback",
						`Status: ${msg.status} | Type: ${msg.resultType}\n${msg.detail}`,
						model,
					),
				});
				break;

			case "tool_arg_error":
				result.push({
					role: "tool",
					content: [
						{
							type: "tool-result" as const,
							toolCallId: msg.callId,
							toolName: msg.tool,
							output: {
								type: "text" as const,
								value: wrapTag("error", `Invalid tool arguments: ${msg.error}`, model),
							},
						},
					],
				});
				break;
		}
	}

	return result;
}

/** 构建 user_input 消息内容 */
function buildUserInputContent(
	msg: Extract<DomainMessage, { type: "user_input" }>,
	model: string,
): string {
	const parts: string[] = [];
	if (msg.context) {
		parts.push(wrapTag("context", msg.context, model));
	}
	if (msg.capabilities) {
		parts.push(wrapTag("capabilities", msg.capabilities, model));
	}
	parts.push(msg.content);
	if (msg.hint) {
		parts.push(wrapTag("hint", msg.hint, model));
	}
	return parts.join("\n\n");
}
