/**
 * DomainMessage ↔ AI SDK ModelMessage 转换
 *
 * 领域消息是结构化数据记录，这里负责转换为 AI SDK 需要的 ModelMessage 格式。
 * 所有输出统一为 XML + Markdown 混合结构：
 * - XML 标签划分内容边界，便于模型理解结构
 * - 标签内部为纯文本 / Markdown，无需 XML 转义
 *
 * 支持 Anthropic prompt caching：通过 providerOptions 注入 cache_control。
 * 缓存断点策略：system prompt + 倒数第二条 user/tool 消息，
 * 确保历史对话大部分都在缓存前缀范围内，只有最新一轮需要重新计算。
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
 * 为原生 Anthropic provider 创建 providerOptions（prompt caching）
 *
 * Prompt caching 有两条互斥路径（由 ProviderConfig.provider 判别）：
 * 1. 原生 Anthropic（provider === "anthropic"）：
 *    本文件通过 providerOptions 注入 cacheControl，AI SDK @ai-sdk/anthropic 负责传递。
 * 2. litellm 代理（provider === "openai-compatible" + backendProvider === "anthropic"）：
 *    provider.ts 通过 fetch wrapper 在 HTTP body 中注入 cache_control。
 *
 * 两条路径由 providerType 字符串天然互斥，不会双重注入。
 */
function anthropicCacheControl(): {
	anthropic: { cacheControl: { type: "ephemeral" } };
} {
	return { anthropic: { cacheControl: { type: "ephemeral" } } };
}

/**
 * 为 Anthropic 消息列表注入缓存断点（后置处理）。
 *
 * Anthropic 最多支持 4 个缓存断点（ephemeral），采用激进策略全部用满：
 * 1. 最后一条 system 消息 — 缓存稳定的 system prompt
 * 2. 倒数第四条 non-assistant 消息 — 较早历史的兜底缓存
 * 3. 倒数第三条 non-assistant 消息 — 中段历史缓存
 * 4. 倒数第二条 non-assistant 消息 — 最近历史缓存
 *
 * 梯度兜底：即使对话快速增长导致某个断点失效，后续断点仍能命中，
 * 最大化 cache hit rate。最新一条 non-assistant 消息始终不缓存（刚发出，下轮才有价值）。
 */
function injectAnthropicCacheBreakpoints(messages: ModelMessage[]): void {
	// 断点 1：最后一条 system 消息
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "system") {
			(messages[i] as Record<string, unknown>).providerOptions =
				anthropicCacheControl();
			break;
		}
	}

	// 断点 2-4：倒数第四、第三、第二条 non-assistant 消息（梯度兜底）
	// 收集从末尾开始的 non-assistant 消息索引
	const nonAssistantIndices: number[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i]!.role;
		if (role === "user" || role === "tool") {
			nonAssistantIndices.push(i);
			if (nonAssistantIndices.length >= 4) break;
		}
	}

	// 跳过最新一条（index 0），在倒数第二、第三、第四条上设断点
	for (let k = 1; k < nonAssistantIndices.length; k++) {
		const targetIdx = nonAssistantIndices[k]!;
		(messages[targetIdx] as Record<string, unknown>).providerOptions =
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
	const isAnthropic = providerType === "anthropic";

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
