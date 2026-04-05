/**
 * format-prompt — DomainMessage[] → PromptMessage[]
 *
 * 从 @n0n/llm/adapter.ts 迁移的提示词组织逻辑。
 * 纯函数，只依赖 @n0n/types 和 tags.ts。
 *
 * 职责：
 * - tool result 格式化（exec/write/edit/reminder/submit）
 * - user_input 上下文拼接
 * - 连续 system 消息合并
 * - idle_nudge / reminder:due / submit:rejected 等文本生成
 * - XML tag 风格适配
 *
 * 不包含：协议消息格式构造、prompt caching 注入 — 这些属于 Client 内部。
 *
 * 设计决策：工具结果的格式化（formatExecResult / formatWriteResult / formatEditResult）
 * 内聚在本模块而非各工具自身。原因：
 * 1. 提示词格式化是面向模型的适配层，不同模型/用户可能需要不同的格式化策略。
 *    工具自身不应关心"被用于什么场景"或"面向什么模型"。
 * 2. 所有工具的格式化逻辑集中在一处，便于统一审查提示词质量、
 *    调整 XML tag 风格、或为不同模型切换整套格式化方案。
 * 3. 工具层只产出纯数据的 ToolResult（DomainMessage），格式化职责完全属于 adapter 层。
 *
 * 简言之，本模块是 DomainMessage → PromptMessage 的集中式 adapter，
 * 工具特化的格式逻辑内聚在此是刻意设计（统一适配层），不是职责泄漏。
 */

import type {
	DomainMessage,
	EditDiff,
	EditToolResult,
	ExecToolResult,
	PromptMessage,
	ToolCallPart,
	ToolResult,
	WriteToolResult,
} from "@n0n/types";
import { adaptTagsFor, wrapTagFor } from "./tags.ts";

// ── tag 工具（内部封装） ──

function wrapTag(name: string, content: string, model: string): string {
	return wrapTagFor(name, content, model);
}

function adaptTags(text: string, model: string): string {
	return adaptTagsFor(text, model);
}

// ── tool result 格式化 ──

function formatExecResult(msg: ExecToolResult, model: string): string {
	switch (msg.status) {
		case "timed_out": {
			const meta = `[${msg.call.args.runtime ?? "unknown"}] [cwd: ${msg.call.args.cwd ?? "."}] [timed out after ${msg.durationMs}ms]`;
			const parts = [wrapTag("exec_meta", meta, model)];
			const notice = [
				`Process exceeded timeout, moved to background.`,
				`PID: ${msg.pid}`,
				`Log file: ${msg.logFile}`,
				`Read the log file later to check process status.`,
			].join("\n");
			parts.push(wrapTag("timeout_notice", notice, model));
			if (msg.stdoutSoFar)
				parts.push(wrapTag("stdout", msg.stdoutSoFar, model));
			if (msg.stderrSoFar)
				parts.push(wrapTag("stderr", msg.stderrSoFar, model));
			return parts.join("\n");
		}
		case "truncated": {
			const meta = `[${msg.call.args.runtime ?? "unknown"}] [cwd: ${msg.call.args.cwd ?? "."}] [exit: ${msg.exitCode}] [${msg.durationMs}ms] [output truncated → ${msg.outputFile}]`;
			const parts = [wrapTag("exec_meta", meta, model)];
			if (msg.stdoutTail)
				parts.push(
					wrapTag(
						"stdout",
						`... (last ${msg.totalLines - msg.tailStartLine + 1} of ${msg.totalLines} lines)\n${msg.stdoutTail}`,
						model,
					),
				);
			if (msg.stderrTail)
				parts.push(
					wrapTag(
						"stderr",
						`... (truncated)\n${msg.stderrTail}`,
						model,
					),
				);
			const hint = [
				`Full output (${msg.totalLines} lines) written to: ${msg.outputFile}`,
				`Use exec to read specific parts: grep, sed, head, tail, or bun script.`,
				`Do NOT re-cat the full file — it will be truncated again.`,
			].join("\n");
			parts.push(wrapTag("output_hint", hint, model));
			return parts.join("\n");
		}
		case "completed": {
			const meta = `[${msg.call.args.runtime ?? "unknown"}] [cwd: ${msg.call.args.cwd ?? "."}] [exit: ${msg.exitCode}] [${msg.durationMs}ms]`;
			const parts = [wrapTag("exec_meta", meta, model)];
			if (msg.stdout) parts.push(wrapTag("stdout", msg.stdout, model));
			if (msg.stderr) parts.push(wrapTag("stderr", msg.stderr, model));
			// 检测模块/包未找到错误，附加诊断提示帮助 LLM 理解原因
			const combined = (msg.stdout || "") + (msg.stderr || "");
			if (
				msg.exitCode !== 0 &&
				/Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|No module named/i.test(combined)
			) {
				parts.push(
					wrapTag(
						"diagnostic_hint",
						"Package/module not found. Possible causes: (1) the package is not listed in the project root dependencies — check package.json; (2) dependencies not installed — run the appropriate install command; (3) for Python with uv, declare inline dependencies using PEP 723 `# /// script` metadata.",
						model,
					),
				);
			}
			return parts.join("\n");
		}
		default: {
			const _exhaustive: never = msg;
			return `Unknown exec status: ${(msg as any).status}`;
		}
	}
}

function formatWriteResult(msg: WriteToolResult, model: string): string {
	switch (msg.status) {
		case "completed":
			return wrapTag("write_result", `Written to \`${msg.call.args.path}\``, model);
		case "failed":
			return wrapTag("error", `Write failed: ${msg.error}`, model);
		case "recovered": {
			const hint = [
				`Partial write to \`${msg.call.args.path}\` (content was truncated by max_tokens).`,
				`The file contains only the first portion of your intended content.`,
				``,
				`To complete it, choose one strategy:`,
				`1. Write the remaining content to a temp file, then use exec to append it: exec({ script: "cat tmp_rest.txt >> target_file" })`,
				`2. Break the file into smaller, well-structured modules and write each separately.`,
				`Do NOT use edit for large appends — it is intent-driven and not suited for bulk content insertion.`,
			].join("\n");
			return wrapTag("write_result", hint, model);
		}
		case "recover_failed":
			return wrapTag("error", `Write failed after truncation recovery: ${msg.error}`, model);
		default: {
			const _exhaustive: never = msg;
			return wrapTag("error", `Unknown write status: ${(msg as any).status}`, model);
		}
	}
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
				`Reminder set. Commitment: ${delay} rounds for next step. A <reminder> will be injected when it expires.`,
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

	for (const msg of messages) {
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
					content: toolResultToContent(msg, modelId),
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
						`Your reminder fired (set ${msg.originalDelay} rounds ago):\n${msg.content}`,
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
