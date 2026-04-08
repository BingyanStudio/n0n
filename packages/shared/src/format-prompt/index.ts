/**
 * format-prompt — DomainMessage[] → PromptMessage[]
 *
 * 提示词组织的编排层。将领域消息转换为协议无关的提示词消息格式。
 * 工具结果的格式化委托给各自的模块（format-exec / format-write / format-edit），
 * 每个模块内维护 anti-few-shot 表述变体，通过确定性种子选择，保证 prompt cache 安全。
 *
 * 职责：
 * - tool result 格式化（委托子模块）
 * - user_input 上下文拼接
 * - 连续 system 消息合并
 * - idle_nudge / reminder:due / submit:rejected 等文本生成
 * - XML tag 风格适配
 *
 * 不包含：协议消息格式构造、prompt caching 注入 — 这些属于 Client 内部。
 */

import type {
	DomainMessage,
	ExecToolResult,
	EditToolResult,
	PromptMessage,
	ToolCallPart,
	ToolResult,
	WriteToolResult,
} from "@n0n/types";
import { adaptTags, pick, wrapTag } from "./utils.ts";
import { formatExecResult } from "./format-exec.ts";
import { formatWriteResult } from "./format-write.ts";
import { formatEditResult } from "./format-edit.ts";

// ── 自然语言变体模板 ──

const reminderSetTemplates = [
	(est: number) =>
		`Reminder set. Estimate: ${est} rounds for next step. A <reminder> will appear when it expires.`,
	(est: number) =>
		`Reminder saved (fires in ~${est} rounds). You'll see a <reminder> when it's time.`,
	(est: number) =>
		`Got it — reminder scheduled, estimated ${est} rounds out. A <reminder> tag will notify you.`,
];

const submitSuccessTemplates = [
	"Submitted successfully.",
	"Submission received.",
	"Result submitted.",
];

const idleNudgeTemplates = [
	(idle: number, max: number) =>
		`You replied with plain text without using any tools. You MUST use tools to make progress. Idle ${idle}/${max}.`,
	(idle: number, max: number) =>
		`No tool calls detected in your last response. Use tools to proceed — idle count: ${idle}/${max}.`,
	(idle: number, max: number) =>
		`Plain text response without tool usage. Tools are required to make progress (${idle}/${max} idle rounds).`,
];

const reminderDueTemplates = [
	(est: number, content: string) =>
		`Your reminder has fired (estimate was ${est} rounds). Review and recalibrate:\n${content}`,
	(est: number, content: string) =>
		`Reminder triggered (originally set for ~${est} rounds). Check progress:\n${content}`,
	(est: number, content: string) =>
		`Scheduled reminder (est. ${est} rounds) — time to review:\n${content}`,
];

const turnFeedbackTemplates = [
	(status: string, type: string, detail: string) =>
		`Status: ${status} | Type: ${type}\n${detail}`,
	(status: string, type: string, detail: string) =>
		`[${status}] result_type=${type}\n${detail}`,
	(status: string, type: string, detail: string) =>
		`Outcome: ${status} (${type})\n${detail}`,
];

const toolArgErrorTemplates = [
	(error: string) => `Invalid tool arguments: ${error}`,
	(error: string) => `Tool argument validation failed: ${error}`,
	(error: string) => `Bad tool args — ${error}`,
];

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
		case "reminder": {
			const estimate = msg.call.args.estimate ?? 7;
			const tpl = pick(reminderSetTemplates, msgIndex);
			return wrapTag("result", tpl(estimate), model);
		}
		case "submit": {
			const text = pick(submitSuccessTemplates, msgIndex);
			const parts = [wrapTag("result", text, model)];
			if ("userResponse" in msg && msg.userResponse) {
				parts.push(wrapTag("user_response", msg.userResponse, model));
			}
			return parts.join("\n");
		}
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
 * 将领域消息转换为协议无关的提示词消息格式。
 * Client 内部消费此输出，进一步转换为各自的 API 格式。
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
				result.push({
					role: "user",
					content: msg.content,
				});
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

			case "idle_nudge": {
				const tpl = pick(idleNudgeTemplates, i);
				result.push({
					role: "user",
					content: wrapTag(
						"system_warning",
						tpl(msg.idleCount, msg.maxIdleRounds),
						modelId,
					),
				});
				break;
			}

			case "reminder:due": {
				const tpl = pick(reminderDueTemplates, i);
				result.push({
					role: "user",
					content: wrapTag(
						"reminder",
						tpl(msg.originalEstimate, msg.content),
						modelId,
					),
				});
				break;
			}

			case "submit:rejected":
				result.push({
					role: "user",
					content: wrapTag(
						"submit_rejected",
						`Submit rejected (attempt ${msg.attempt}/${msg.maxAttempts}): ${msg.error}`,
						modelId,
					),
				});
				break;

			case "user_input":
				result.push({
					role: "user",
					content: buildUserInputContent(msg, modelId),
				});
				break;

			case "turn_feedback": {
				const tpl = pick(turnFeedbackTemplates, i);
				result.push({
					role: "user",
					content: wrapTag(
						"turn_feedback",
						tpl(msg.status, msg.resultType, msg.detail),
						modelId,
					),
				});
				break;
			}

			case "tool_arg_error": {
				const errorTpl = pick(toolArgErrorTemplates, i);
				let errorContent = errorTpl(msg.error);
				if (msg.schema) {
					errorContent += `\n\nExpected schema:\n${JSON.stringify(msg.schema, null, 2)}`;
				}
				result.push({
					role: "tool",
					toolCallId: msg.callId,
					toolName: msg.tool,
					content: wrapTag("error", errorContent, modelId),
				});
				break;
			}

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
