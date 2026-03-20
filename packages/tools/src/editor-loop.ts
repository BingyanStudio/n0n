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
import {
	chatCompletionStream,
	createModelFromConfig,
	StreamAccumulator,
} from "@n0n/llm";
import type { ModelMessage, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import editorAgentPrompt from "./descriptions/editor-agent.md" with {
	type: "text",
};

// ── Editor LLM 内部工具定义（AI SDK ToolSet 格式） ──

const EDITOR_TOOL_SET: ToolSet = {
	str_replace: tool({
		description:
			"Replace an exact substring in the file. The old_string must match character-for-character (including whitespace). Use the minimal unique fragment needed to identify the location.",
		inputSchema: jsonSchema({
			type: "object",
			properties: {
				old_string: {
					type: "string",
					description: "Exact substring to find in the current file content",
				},
				new_string: {
					type: "string",
					description: "Replacement text. Use empty string for deletions.",
				},
			},
			required: ["old_string", "new_string"],
			additionalProperties: false,
		}),
	}),
	view_file: tool({
		description:
			"View the current file content after previous edits. Use this to verify the file state before making further changes.",
		inputSchema: jsonSchema({
			type: "object",
			properties: {},
			additionalProperties: false,
		}),
	}),
	submit: tool({
		description:
			"Submit when all edits are complete. Optionally provide feedback on the caller's intent quality.",
		inputSchema: jsonSchema({
			type: "object",
			properties: {
				feedback: {
					type: "string",
					description:
						"Optional feedback if the caller's intent could be improved: over-specified (contains line numbers/verbatim code), too large (should split), or too vague (cannot locate target). Omit if intent is clear.",
				},
			},
			additionalProperties: false,
		}),
	}),
};

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
	const model = createModelFromConfig(editorLlm);

	const messages: ModelMessage[] = [
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
		const acc = new StreamAccumulator();
		let message: ReturnType<StreamAccumulator["toMessage"]>;
		try {
			for await (const event of chatCompletionStream(
				{
					messages,
					tools: EDITOR_TOOL_SET,
					toolChoice: "required",
					temperature: 0,
				},
				{ model },
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

		if (!message.toolCalls.length) {
			// 无工具调用 → 推一轮 assistant + user 提示
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

		// 预解析所有 tool call 参数（避免 double parse）
		const parsedToolCalls: Array<{
			tc: (typeof message.toolCalls)[number];
			args: Record<string, unknown> | null;
		}> = message.toolCalls.map((tc) => {
			try {
				return { tc, args: JSON.parse(tc.input) as Record<string, unknown> };
			} catch {
				return { tc, args: null };
			}
		});

		// 构建 assistant 消息（包含 tool calls）
		messages.push({
			role: "assistant",
			content: [
				...(message.content
					? [{ type: "text" as const, text: message.content }]
					: []),
				...parsedToolCalls
					.filter((p) => p.args !== null)
					.map((p) => ({
						type: "tool-call" as const,
						toolCallId: p.tc.toolCallId,
						toolName: p.tc.toolName,
						input: p.args,
					})),
			],
		});

		for (const { tc, args } of parsedToolCalls) {
			const name = tc.toolName;
			if (args === null) {
				messages.push({
					role: "tool",
					content: [
						{
							type: "tool-result" as const,
							toolCallId: tc.toolCallId,
							toolName: name,
							output: {
								type: "text" as const,
								value: "Error: Failed to parse tool arguments as JSON.",
							},
						},
					],
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
							content: [
								{
									type: "tool-result" as const,
									toolCallId: tc.toolCallId,
									toolName: name,
									output: {
										type: "text" as const,
										value: "Error: old_string cannot be empty.",
									},
								},
							],
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
							content: [
								{
									type: "tool-result" as const,
									toolCallId: tc.toolCallId,
									toolName: name,
									output: {
										type: "text" as const,
										value: `OK: Replacement applied (edit #${editCount}).`,
									},
								},
							],
						});
						onToolResult?.(round, `str_replace → edit #${editCount}`);
					} else {
						messages.push({
							role: "tool",
							content: [
								{
									type: "tool-result" as const,
									toolCallId: tc.toolCallId,
									toolName: name,
									output: {
										type: "text" as const,
										value: [
											`Error: ${result.error}`,
											"",
											"Check whitespace, indentation, and character-for-character accuracy.",
											"Call view_file to see the current file content.",
										].join("\n"),
									},
								},
							],
						});
						onToolResult?.(round, `str_replace → ${result.error}`);
					}
					break;
				}

				case "view_file": {
					messages.push({
						role: "tool",
						content: [
							{
								type: "tool-result" as const,
								toolCallId: tc.toolCallId,
								toolName: name,
								output: {
									type: "text" as const,
									value: `<source_file>\n${current}\n</source_file>`,
								},
							},
						],
					});
					onToolResult?.(round, "view_file → ok");
					break;
				}

				case "submit": {
					const feedback =
						typeof args.feedback === "string" && args.feedback.length > 0
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
						content: [
							{
								type: "tool-result" as const,
								toolCallId: tc.toolCallId,
								toolName: name,
								output: {
									type: "text" as const,
									value: `Error: Unknown tool "${name}". Use str_replace, view_file, or submit.`,
								},
							},
						],
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
