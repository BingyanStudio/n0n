/**
 * DomainMessage ↔ AI SDK ModelMessage 转换
 *
 * 领域消息是结构化数据记录，这里负责转换为 AI SDK 需要的 ModelMessage 格式。
 * 所有输出统一为 XML + Markdown 混合结构：
 * - XML 标签划分内容边界，便于模型理解结构
 * - 标签内部为纯文本 / Markdown，无需 XML 转义
 *
 * 支持 Anthropic prompt caching：缓存断点选择逻辑见 cache.ts（SSOT），
 * 本文件通过 providerOptions 注入 AI SDK @ai-sdk/anthropic 的 cacheControl。
 */

import type {
	DomainMessage,
	EditDiff,
	EditToolResult,
	ExecToolResult,
	ToolResult,
	WriteToolResult,
} from "@n0n/types";
import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";
import { anthropicCacheControl, selectCacheBreakpoints } from "./cache.ts";
import { isAnthropicProvider } from "./config.ts";
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

/* ── Prompt Caching ── */

/**
 * 为 Anthropic 消息列表注入缓存断点（后置处理）。
 *
 * 使用 selectCacheBreakpoints（SSOT）选择断点位置，
 * 通过 providerOptions 注入 AI SDK @ai-sdk/anthropic 的 cacheControl。
 */
function injectAnthropicCacheBreakpoints(messages: ModelMessage[]): void {
	for (const idx of selectCacheBreakpoints(messages)) {
		(messages[idx] as Record<string, unknown>).providerOptions =
			anthropicCacheControl();
	}
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
	const isAnthropic = isAnthropicProvider(providerType ?? "");

	for (const msg of messages) {
		switch (msg.type) {
			case "system": {
				const sysMsg: ModelMessage = {
					role: "system",
					content: adaptTags(msg.content, model),
				};
				result.push(sysMsg);
				break;
			}

			case "user_text": {
				const userMsg: ModelMessage = {
					role: "user",
					content: msg.content,
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
				if (msg.reasoning) {
					result.push({
						role: "assistant",
						content: [
							{ type: "reasoning" as const, text: msg.reasoning },
							{ type: "text" as const, text: msg.content },
						],
					});
				} else {
					result.push({
						role: "assistant",
						content: msg.content,
					});
				}
				break;
			}

			case "assistant_tool_call": {
				const assistantMsg: AssistantModelMessage = {
					role: "assistant",
					content: [
						// reasoning 内容（交替思考需要回传历史 thinking）
						...(msg.reasoning
							? [{ type: "reasoning" as const, text: msg.reasoning }]
							: []),
						// 文本内容（如果有）
						...(msg.content
							? [{ type: "text" as const, text: msg.content }]
							: []),
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
								value: wrapTag(
									"error",
									`Invalid tool arguments: ${msg.error}`,
									model,
								),
							},
						},
					],
				});
				break;
		}
	}

	// 合并连续的 system 消息 — 部分模型（如 minimax）不支持多个 system 消息，
	// AI SDK 不会自动合并。合并对支持多 system 的模型无害（语义等价）。
	const merged = mergeConsecutiveSystem(result);

	// Anthropic prompt caching：后置注入缓存断点
	if (isAnthropic) {
		injectAnthropicCacheBreakpoints(merged);
	}

	return merged;
}

/** 合并连续的 system 消息为单条（保留最后一条的 providerOptions） */
function mergeConsecutiveSystem(messages: ModelMessage[]): ModelMessage[] {
	const merged: ModelMessage[] = [];
	for (const msg of messages) {
		const prev = merged[merged.length - 1];
		if (
			msg.role === "system" &&
			prev?.role === "system" &&
			typeof msg.content === "string" &&
			typeof prev.content === "string"
		) {
			// 合并内容，保留后者的 providerOptions（如 cache_control）
			merged[merged.length - 1] = {
				...prev,
				content: `${prev.content}\n\n${msg.content}`,
				...("providerOptions" in msg && msg.providerOptions
					? { providerOptions: msg.providerOptions }
					: {}),
			};
		} else {
			merged.push(msg);
		}
	}
	return merged;
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
