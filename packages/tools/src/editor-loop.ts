/**
 * Editor Loop — Editor LLM 专用循环
 *
 * 驱动 Editor LLM 通过 str_replace/view_file/submit 完成编辑任务。
 * 完全封装，不依赖 @n0n/core。
 *
 * 流程：
 * 1. 发送 [system, user(source + intent)]
 * 2. Editor LLM 调用 str_replace → 执行替换 → 返回结果
 * 3. Editor LLM 调用 view_file → 返回当前文件内容
 * 4. Editor LLM 调用 submit → 提取 feedback → 退出循环
 * 5. 达到上限 → 返回最后的错误
 */

import type { LLMConfig } from "@n0n/llm";
import { chatCompletionStream, StreamAccumulator } from "@n0n/llm";
import type { LLMRequestMessage, LLMToolDefinition } from "@n0n/types";
import editorAgentPrompt from "./descriptions/editor-agent.md" with {
	type: "text",
};

// ── Editor LLM 内部工具定义 ──

const STR_REPLACE_TOOL: LLMToolDefinition = {
	type: "function",
	function: {
		name: "str_replace",
		description:
			"Replace an exact substring in the file. The old_string must match character-for-character (including whitespace). Use the minimal unique fragment needed to identify the location.",
		parameters: {
			type: "object",
			properties: {
				old_string: {
					type: "string",
					description:
						"Exact substring to find in the current file content",
				},
				new_string: {
					type: "string",
					description:
						"Replacement text. Use empty string for deletions.",
				},
			},
			required: ["old_string", "new_string"],
			additionalProperties: false,
		},
	},
};

const VIEW_FILE_TOOL: LLMToolDefinition = {
	type: "function",
	function: {
		name: "view_file",
		description:
			"View the current file content after previous edits. Use this to verify the file state before making further changes.",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
};

const SUBMIT_TOOL: LLMToolDefinition = {
	type: "function",
	function: {
		name: "submit",
		description:
			"Submit when all edits are complete. Optionally provide feedback on the caller's intent quality.",
		parameters: {
			type: "object",
			properties: {
				feedback: {
					type: "string",
					description:
						"Optional feedback if the caller's intent could be improved: over-specified (contains line numbers/verbatim code), too large (should split), or too vague (cannot locate target). Omit if intent is clear.",
				},
			},
			additionalProperties: false,
		},
	},
};

const EDITOR_TOOLS: LLMToolDefinition[] = [
	STR_REPLACE_TOOL,
	VIEW_FILE_TOOL,
	SUBMIT_TOOL,
];

/** Editor LLM 最大循环轮数 */
const MAX_ROUNDS = 15;

// ── applySingleOp ──

/**
 * 应用单次 search/replace 操作到源文件内容。
 * 归一化 CRLF 换行符，确保 LLM 生成的 \n 能匹配源文件的 \r\n。
 */
export function applySingleOp(
	source: string,
	oldStr: string,
	newStr: string,
): { ok: true; content: string } | { ok: false; error: string } {
	const useCrlf = source.includes("\r\n");
	const normSource = useCrlf ? source.replace(/\r\n/g, "\n") : source;
	const normOld = oldStr.replace(/\r\n/g, "\n");

	const idx = normSource.indexOf(normOld);
	if (idx === -1) {
		const preview =
			normOld.length > 80 ? `${normOld.slice(0, 80)}...` : normOld;
		return { ok: false, error: `Search text not found: "${preview}"` };
	}

	const secondIdx = normSource.indexOf(normOld, idx + 1);
	if (secondIdx !== -1) {
		const preview =
			normOld.length > 80 ? `${normOld.slice(0, 80)}...` : normOld;
		return {
			ok: false,
			error: `Search text matches multiple locations: "${preview}"`,
		};
	}

	const normNew = useCrlf
		? newStr.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")
		: newStr.replace(/\r\n/g, "\n");

	const content =
		normSource.slice(0, idx) +
		normNew +
		normSource.slice(idx + normOld.length);

	return {
		ok: true,
		content: useCrlf ? content.replace(/\n/g, "\r\n") : content,
	};
}

// ── Editor Loop ──

export interface EditorLoopResult {
	content: string;
	feedback: string | null;
	error: string | null;
	rounds: number;
}

/**
 * Editor LLM 专用循环：驱动 Editor LLM 通过 str_replace/view_file/submit
 * 完成编辑任务。
 *
 * @param onEvent  流式事件回调（每个 SSE token）
 * @param onToolResult  工具执行结果回调（每次 tool 完成后）
 */
export async function editorLoop(
	source: string,
	intent: string,
	editorLlm: LLMConfig,
	onEvent?: (
		round: number,
		event: import("@n0n/llm").StreamEvent,
	) => void,
	onToolResult?: (round: number, summary: string) => void,
): Promise<EditorLoopResult> {
	let current = source;
	let editCount = 0;

	const messages: LLMRequestMessage[] = [
		{ role: "system", content: editorAgentPrompt },
		{
			role: "user",
			content: [
				"<source_file>",
				source,
				"</source_file>",
				"",
				"<edit_intent>",
				intent,
				"</edit_intent>",
			].join("\n"),
		},
	];

	for (let round = 0; round < MAX_ROUNDS; round++) {
		let message: ReturnType<StreamAccumulator["toMessage"]>;
		try {
			const acc = new StreamAccumulator();
			for await (const event of chatCompletionStream(
				{
					messages,
					tools: EDITOR_TOOLS,
					tool_choice: "required",
					temperature: 0,
				},
				{ llm: editorLlm },
			)) {
				acc.push(event);
				onEvent?.(round, event);
			}
			message = acc.toMessage();
		} catch (err) {
			return {
				content: current,
				feedback: null,
				error: `Editor LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
				rounds: round + 1,
			};
		}

		if (!message.tool_calls?.length) {
			messages.push({
				role: "assistant",
				content: message.content ?? "",
			});
			messages.push({
				role: "user",
				content:
					"You must call a tool. Use str_replace to make changes, view_file to check the file, or submit when done.",
			});
			continue;
		}

		messages.push({
			role: "assistant",
			content: message.content,
			tool_calls: message.tool_calls?.map((tc) => ({
				id: tc.id,
				type: tc.type,
				function: tc.function,
			})),
		});

		for (const tc of message.tool_calls) {
			const name = tc.function.name;
			let args: Record<string, unknown>;
			try {
				args = JSON.parse(tc.function.arguments);
			} catch {
				messages.push({
					role: "tool",
					tool_call_id: tc.id,
					content: "Error: Failed to parse tool arguments as JSON.",
				});
				onToolResult?.(round, "parse error");
				continue;
			}

			switch (name) {
				case "str_replace": {
					const oldStr = String(args.old_string ?? "");
					const newStr = String(args.new_string ?? "");

					if (!oldStr) {
						messages.push({
							role: "tool",
							tool_call_id: tc.id,
							content: "Error: old_string cannot be empty.",
						});
						onToolResult?.(round, "str_replace → old_string empty");
						break;
					}

					const result = applySingleOp(current, oldStr, newStr);
					if (result.ok) {
						current = result.content;
						editCount++;
						messages.push({
							role: "tool",
							tool_call_id: tc.id,
							content: `OK: Replacement applied (edit #${editCount}).`,
						});
						onToolResult?.(
							round,
							`str_replace → edit #${editCount}`,
						);
					} else {
						messages.push({
							role: "tool",
							tool_call_id: tc.id,
							content: [
								`Error: ${result.error}`,
								"",
								"Check whitespace, indentation, and character-for-character accuracy.",
								"Call view_file to see the current file content.",
							].join("\n"),
						});
						onToolResult?.(
							round,
							`str_replace → ${result.error}`,
						);
					}
					break;
				}

				case "view_file": {
					messages.push({
						role: "tool",
						tool_call_id: tc.id,
						content: `<source_file>\n${current}\n</source_file>`,
					});
					onToolResult?.(round, "view_file → ok");
					break;
				}

				case "submit": {
					const feedback =
						typeof args.feedback === "string" &&
						args.feedback.length > 0
							? args.feedback
							: null;

					onToolResult?.(round, "submit");
					return {
						content: current,
						feedback,
						error: null,
						rounds: round + 1,
					};
				}

				default: {
					messages.push({
						role: "tool",
						tool_call_id: tc.id,
						content: `Error: Unknown tool "${name}". Use str_replace, view_file, or submit.`,
					});
					onToolResult?.(round, `unknown tool: ${name}`);
				}
			}
		}
	}

	return {
		content: current,
		feedback: null,
		error: `Editor LLM did not submit within ${MAX_ROUNDS} rounds (${editCount} edits applied).`,
		rounds: MAX_ROUNDS,
	};
}
