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
import { adaptTagsFor, wrapTagFor } from "../tags.ts";
import { formatExecResult } from "./format-exec.ts";
import { formatWriteResult } from "./format-write.ts";
import { formatEditResult } from "./format-edit.ts";

// ── tag 工具（内部封装） ──

function wrapTag(name: string, content: string, model: string): string {
	return wrapTagFor(name, content, model);
}

function adaptTags(text: string, model: string): string {
	return adaptTagsFor(text, model);
}

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
			return wrapTag(
				"result",
				`Reminder set. Estimate: ${estimate} rounds for next step. A <reminder> will appear when it expires.`,
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

			case "user_text":
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

			case "idle_nudge":
				result.push({
					role: "user",
					content: wrapTag(
						"system_warning",
						`You replied with plain text without using any tools. You MUST use tools to make progress. Idle ${msg.idleCount}/${msg.maxIdleRounds}.`,
						modelId,
					),
				});
				break;

			case "reminder:due":
				result.push({
					role: "user",
					content: wrapTag(
						"reminder",
						`Your reminder has fired (estimate was ${msg.originalEstimate} rounds). Review and recalibrate:\n${msg.content}`,
						modelId,
					),
				});
				break;

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

			case "turn_feedback":
				result.push({
					role: "user",
					content: wrapTag(
						"turn_feedback",
						`Status: ${msg.status} | Type: ${msg.resultType}\n${msg.detail}`,
						modelId,
					),
				});
				break;

			case "tool_arg_error": {
				let errorContent = `Invalid tool arguments: ${msg.error}`;
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
