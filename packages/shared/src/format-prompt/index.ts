/**
 * format-prompt — DomainMessage[] → PromptMessage[]
 *
 * 纯编排层。将领域消息转换为协议无关的提示词消息格式。
 * 所有含自然语言的格式化逻辑委托给各自的子模块，
 * 每个模块内维护 anti-few-shot 表述变体。
 *
 * Anti-few-shot 设计动机（参考 Manus "Don't Get Few-Shotted"）：
 * LLM 是出色的模仿者，会复现上下文中的行为模式。当上下文充满结构
 * 相同的"行动-观测"对时，模型倾向于遵循该模式，即使它不再是最佳
 * 选择——导致偏离、过度泛化甚至幻觉。解决方法是在行动和观测中引入
 * 受控的结构化变体（不同的序列化模板、替代措辞、格式微噪音），
 * 打破模式并调整模型注意力。上下文越统一，Agent 越脆弱。
 *
 * 不包含：协议消息格式构造、prompt caching 注入 — 这些属于 Client 内部。
 */

import type {
	DomainMessage,
	ExecToolResult,
	EditToolResult,
	PromptMessage,
	ReminderToolResult,
	SubmitToolResult,
	ToolCallPart,
	ToolResult,
	WriteToolResult,
} from "@n0n/types";
import { adaptTags, wrapTag } from "./utils.ts";
import { formatExecResult } from "./format-exec.ts";
import { formatWriteResult } from "./format-write.ts";
import { formatEditResult } from "./format-edit.ts";
import { formatReminderResult } from "./format-reminder.ts";
import { formatSubmitResult } from "./format-submit.ts";
import { formatSubmitRejected } from "./format-submit-rejected.ts";
import { formatIdleNudge } from "./format-idle-nudge.ts";
import { formatReminderDue } from "./format-reminder-due.ts";
import { formatTurnFeedback } from "./format-turn-feedback.ts";
import { formatToolArgError } from "./format-tool-arg-error.ts";

// ── tool result 分发 ──

function toolResultToContent(
	msg: ToolResult,
	model: string,
	msgIndex: number,
): string {
	switch (msg.call.tool) {
		case "exec":
			return formatExecResult(msg as ExecToolResult, model, msgIndex);
		case "write":
			return formatWriteResult(msg as WriteToolResult, model, msgIndex);
		case "edit":
			return formatEditResult(msg as EditToolResult, model, msgIndex);
		case "reminder":
			return formatReminderResult(msg as ReminderToolResult, model, msgIndex);
		case "submit":
			return formatSubmitResult(msg as SubmitToolResult, model, msgIndex);
	}
}

// ── user_input 构建 ──

function buildUserInputContent(
	msg: Extract<DomainMessage, { type: "user_input" }>,
	model: string,
): string {
	const parts: string[] = [];
	if (msg.context) {
		parts.push(wrapTag("context", msg.context, model));
	}
	parts.push(msg.content);
	if (msg.hint) {
		parts.push(wrapTag("hint", msg.hint, model));
	}
	return parts.join("\n\n");
}

// ── 连续 system 消息合并 ──

function mergeConsecutiveSystem(messages: PromptMessage[]): PromptMessage[] {
	const merged: PromptMessage[] = [];
	for (const msg of messages) {
		const prev = merged[merged.length - 1];
		if (msg.role === "system" && prev?.role === "system") {
			merged[merged.length - 1] = {
				role: "system",
				content: `${prev.content}\n\n${msg.content}`,
			};
		} else {
			merged.push(msg);
		}
	}
	return merged;
}

// ── 主函数 ──

/**
 * DomainMessage[] → PromptMessage[]
 *
 * @param messages 领域消息历史
 * @param modelId 模型标识，用于 XML tag 风格选择
 */
export function formatPrompt(
	messages: DomainMessage[],
	modelId: string,
): PromptMessage[] {
	const result: PromptMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!;

		switch (msg.type) {
			case "system":
				result.push({
					role: "system",
					content: adaptTags(msg.content, modelId),
				});
				break;

			case "generic_user_text":
				result.push({ role: "user", content: msg.content });
				break;

			case "user_image":
				result.push({
					role: "user",
					content: `[Image: ${msg.imagePath}] ${msg.text}`,
				});
				break;

			case "assistant_text":
				result.push({
					role: "assistant",
					content: msg.content,
					reasoning: msg.reasoning ?? undefined,
					reasoningSignature: msg.reasoningSignature ?? undefined,
				});
				break;

			case "assistant_tool_call": {
				const toolCalls: ToolCallPart[] = msg.toolCalls.map((tc) => ({
					id: tc.id,
					tool: tc.tool,
					args: tc.args,
				}));
				result.push({
					role: "assistant",
					content: msg.content ?? "",
					reasoning: msg.reasoning ?? undefined,
					reasoningSignature: msg.reasoningSignature ?? undefined,
					toolCalls,
				});
				break;
			}

			case "tool_result":
				result.push({
					role: "tool",
					toolCallId: msg.call.id,
					toolName: msg.call.tool,
					content: toolResultToContent(msg, modelId, i),
				});
				break;

			case "idle_nudge":
				result.push({
					role: "user",
					content: formatIdleNudge(msg, modelId, i),
				});
				break;

			case "reminder:due":
				result.push({
					role: "user",
					content: formatReminderDue(msg, modelId, i),
				});
				break;

			case "submit:rejected":
				result.push({
					role: "user",
					content: formatSubmitRejected(msg, modelId, i),
				});
				break;

			case "user_input":
				result.push({
					role: "user",
					content: buildUserInputContent(msg, modelId),
				});
				break;

			case "turn_feedback":
				result.push({
					role: "user",
					content: formatTurnFeedback(msg, modelId, i),
				});
				break;

			case "tool_arg_error":
				result.push({
					role: "tool",
					toolCallId: msg.callId,
					toolName: msg.tool,
					content: formatToolArgError(msg, modelId, i),
				});
				break;

			case "generic_tool_call": {
				const toolCalls: ToolCallPart[] = msg.toolCalls.map((tc) => ({
					id: tc.id,
					tool: tc.tool,
					args: tc.args,
				}));
				result.push({
					role: "assistant",
					content: msg.content ?? "",
					toolCalls,
				});
				break;
			}

			case "generic_tool_result":
				result.push({
					role: "tool",
					toolCallId: msg.callId,
					toolName: msg.toolName,
					content: msg.content,
				});
				break;
		}
	}

	return mergeConsecutiveSystem(result);
}
