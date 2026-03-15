/**
 * DomainMessage ↔ LLM API 消息转换
 *
 * 领域消息是结构化数据记录，这里负责转换为 LLM provider 需要的格式。
 * 所有输出统一为 XML + Markdown 混合结构：
 * - XML 标签划分内容边界，便于模型理解结构
 * - 标签内部为纯文本 / Markdown，无需 XML 转义
 */

import type {
	DomainMessage,
	EditToolResult,
	ExecToolResult,
	LLMRequestMessage,
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

function formatEditResult(msg: EditToolResult, model: string): string {
	if (msg.success) {
		const summary = `Edited \`${msg.call.args.path}\`: +${msg.linesAdded} -${msg.linesRemoved} lines`;
		return wrapTag("edit_result", summary, model);
	}
	const guidance = [
		`Edit failed (rolled back): ${msg.error}`,
		"",
		"Review your commands against standard Vim ex syntax and retry.",
		"Common mistakes: `:s/old/new/` split across lines, missing `.` terminator, pattern not found in file.",
	].join("\n");
	return wrapTag("error", guidance, model);
}

function toolResultToContent(msg: ToolResult, model: string): string {
	switch (msg.call.tool) {
		case "exec":
			return formatExecResult(msg as ExecToolResult, model);
		case "write":
			return formatWriteResult(msg as WriteToolResult, model);
		case "edit":
			return formatEditResult(msg as EditToolResult, model);
		case "reminder":
			return wrapTag(
				"result",
				`Reminder set: will appear in ${msg.call.args.delay ?? 0} rounds`,
				model,
			);
		case "submit": {
			const parts = [wrapTag("result", "Submitted successfully.", model)];
			if ("userResponse" in msg && msg.userResponse) {
				parts.push(wrapTag("user_response", msg.userResponse, model));
			}
			return parts.join("\n");
		}
	}
}

/* ── 主转换函数 ── */

/**
 * DomainMessage[] → LLMRequestMessage[]
 */
export function toAPIMessages(
	messages: DomainMessage[],
	model: string,
): LLMRequestMessage[] {
	const result: LLMRequestMessage[] = [];

	for (const msg of messages) {
		switch (msg.type) {
			case "system":
				result.push({ role: "system", content: adaptTags(msg.content, model) });
				break;

			case "user_text":
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
					...(msg.reasoning ? { reasoning_content: msg.reasoning } : {}),
				});
				break;

			case "assistant_tool_call":
				result.push({
					role: "assistant",
					content: msg.content,
					...(msg.reasoning ? { reasoning_content: msg.reasoning } : {}),
					tool_calls: msg.toolCalls.map((tc) => ({
						id: tc.id,
						type: "function" as const,
						function: {
							name: tc.tool,
							arguments: JSON.stringify(tc.args),
						},
					})),
				});
				break;

			case "tool_result":
				result.push({
					role: "tool",
					tool_call_id: msg.call.id,
					content: toolResultToContent(msg, model),
				});
				break;

			case "idle_nudge":
				result.push({
					role: "user",
					content: wrapTag(
						"system_warning",
						`You replied with plain text without calling any tool (idle ${msg.idleCount}/${msg.maxIdleRounds}).\n\nYou **must** either call \`submit\` to submit your result, or continue calling tools. Do NOT output plain text without a tool call.`,
						model,
					),
				});
				break;

			case "user_input": {
				const parts: string[] = [];
				if (msg.context) parts.push(wrapTag("context", msg.context, model));
				if (msg.capabilities)
					parts.push(wrapTag("capabilities", msg.capabilities, model));
				if (msg.hint) parts.push(wrapTag("system_hint", msg.hint, model));
				parts.push(msg.content);
				result.push({ role: "user", content: parts.join("\n\n") });
				break;
			}

			case "turn_feedback":
				result.push({
					role: "user",
					content: wrapTag(
						"feedback",
						`**${msg.status}** (${msg.resultType})\n\n${msg.detail}`,
						model,
					),
				});
				break;

			case "reminder:due":
				result.push({
					role: "user",
					content: wrapTag(
						"reminder",
						`${msg.content}\n\n⚠️ You **must** set a new reminder (with updated progress) in your next tool call.`,
						model,
					),
				});
				break;

			case "tool_arg_error":
				result.push({
					role: "tool",
					tool_call_id: msg.callId,
					content: [
						wrapTag(
							"error",
							`Parameter error for tool \`${msg.tool}\`: ${msg.error}`,
							model,
						),
						wrapTag("schema", JSON.stringify(msg.schema, null, 2), model),
					].join("\n\n"),
				});
				break;

			case "submit:rejected":
				result.push({
					role: "user",
					content: wrapTag(
						"rejected",
						`${msg.error}\n\nFix the format and submit again. (attempt ${msg.attempt}/${msg.maxAttempts})`,
						model,
					),
				});
				break;
		}
	}

	return result;
}
