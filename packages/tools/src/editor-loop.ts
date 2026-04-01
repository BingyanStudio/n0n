/**
 * Editor Loop — Editor LLM 专用循环
 *
 * 驱动 Editor LLM 通过 str_replace/view_file/submit 完成编辑任务。
 * 完全封装，不依赖 @n0n/core。
 *
 * 流程：
 * 1. 发送 [system, user(source + intent)]
 * 2. Editor LLM 调用 str_replace → 执行替换 → 返回结果
 * 3. Editor LLM 调用 view_file → 返回当前文件内容（支持行号范围）
 * 4. Editor LLM 调用 submit → 提取 feedback → 退出循环
 * 5. 达到上限 → 返回最后的错误
 */

import type {
	DomainMessage,
	LLMClient,
	StreamEvent,
	ToolDefinition,
} from "@n0n/types";
import { StreamAccumulator } from "@n0n/types";
import editorAgentPrompt from "./descriptions/editor-agent.md" with {
	type: "text",
};

// ── Editor LLM 内部工具定义（ToolDefinition 格式） ──

const EDITOR_TOOLS: ToolDefinition[] = [
	{
		name: "str_replace",
		description:
			"Replace an exact substring in the file. The old_string must match character-for-character (including whitespace). Use the minimal unique fragment needed to identify the location.",
		parameters: {
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
				expected_matches: {
					type: "number",
					description:
						"Expected number of matches for old_string. Defaults to 1. If actual matches differ from this value, the replacement is rejected.",
				},
			},
			required: ["old_string", "new_string"],
			additionalProperties: false,
		},
	},
	{
		name: "view_file",
		description:
			"View the current file content after previous edits. Optionally specify a line range to avoid reading the entire file.",
		parameters: {
			type: "object",
			properties: {
				start_line: {
					type: "number",
					description:
						"Start line number (1-based, inclusive). Omit to start from the beginning.",
				},
				end_line: {
					type: "number",
					description:
						"End line number (1-based, inclusive). Omit to read to the end.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "submit",
		description:
			"Submit when edits are complete, OR immediately when the intent is ambiguous/vague/impossible to execute. You MUST always provide deduction-based scored feedback using the [score/4] format.",
		parameters: {
			type: "object",
			properties: {
				feedback: {
					type: "string",
					description:
						"Deduction-based feedback: '[score/4] Verdict. {deductions} Details: ...' — start at 4, subtract: −1 if intent uses line numbers, −1 if those lines are trivially describable by name, −1 ambiguous target, −1 missing change spec, −2 unexecutable, −1 multi-concern. Minimum 0.",
				},
			},
			required: ["feedback"],
			additionalProperties: false,
		},
	},
];

/** Editor LLM 最大循环轮数 */
const MAX_ROUNDS = 15;

// ── 辅助函数 ──

/** 构造 tool result PromptMessage */
function toolResult(
	toolCallId: string,
	toolName: string,
	value: string,
): DomainMessage {
	return {
		type: "generic_tool_result",
		callId: toolCallId,
		toolName,
		content: value,
	};
}

// ── countOccurrences ──

/**
 * 统计 pattern 在 text 中出现的次数。
 */
function countOccurrences(text: string, pattern: string): number {
	if (pattern.length === 0) return 0;
	let count = 0;
	let pos = 0;
	pos = text.indexOf(pattern, pos);
	while (pos !== -1) {
		count++;
		pos += pattern.length;
		pos = text.indexOf(pattern, pos);
	}
	return count;
}

// ── applySingleOp ──

/**
 * 应用单次 search/replace 操作到源文件内容。
 * 归一化 CRLF 换行符，确保 LLM 生成的 \n 能匹配源文件的 \r\n。
 *
 * @param expectedMatches 预期匹配数量，默认为 1。实际匹配数与预期不符时拒绝修改。
 */
export function applySingleOp(
	source: string,
	oldStr: string,
	newStr: string,
	expectedMatches = 1,
): { ok: true; content: string } | { ok: false; error: string } {
	const useCrlf = source.includes("\r\n");
	const normSource = useCrlf ? source.replace(/\r\n/g, "\n") : source;
	const normOld = oldStr.replace(/\r\n/g, "\n");

	const actualMatches = countOccurrences(normSource, normOld);

	if (actualMatches !== expectedMatches) {
		const preview =
			normOld.length > 80 ? `${normOld.slice(0, 80)}...` : normOld;
		if (actualMatches === 0) {
			return {
				ok: false,
				error: `Search text not found: "${preview}" — actual matches: 0, expected matches: ${expectedMatches}. Rejected. Please fix expected_matches or provide more context in old_string for precise matching.`,
			};
		}
		return {
			ok: false,
			error: `Match count mismatch for "${preview}" — actual matches: ${actualMatches}, expected matches: ${expectedMatches}. Rejected. Please fix expected_matches or provide more context in old_string for precise matching.`,
		};
	}

	const normNew = useCrlf
		? newStr.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")
		: newStr.replace(/\r\n/g, "\n");
	const content = normSource.split(normOld).join(normNew);
	return { ok: true, content: useCrlf ? content : content };
}

// ── getReplacementContext ──

/**
 * 获取替换后的上下文（替换位置前后各 2 行），帮助 LLM 确认替换结果。
 */
function getReplacementContext(
	content: string,
	newStr: string,
	contextLines = 2,
): string {
	if (!newStr) return "(deletion — no replacement context)";

	const pos = content.indexOf(newStr);
	if (pos === -1) return "";

	const lines = content.split("\n");
	const linesBefore = content.slice(0, pos).split("\n");
	const replacementStartLine = linesBefore.length;
	const replacementLines = newStr.split("\n").length;

	const start = Math.max(0, replacementStartLine - contextLines - 1);
	const end = Math.min(
		lines.length,
		replacementStartLine + replacementLines + contextLines,
	);

	const numbered = lines
		.slice(start, end)
		.map((line, i) => `${start + i + 1}| ${line}`)
		.join("\n");

	return `Context (L${start + 1}-${end}):\n${numbered}`;
}

// ── EditorLoopResult ──

export interface EditorLoopResult {
	content: string;
	feedback: string | null;
	error: string | null;
	rounds: number;
}

// ── Editor Loop ──

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
	editorClient: LLMClient,
	onEvent?: (round: number, event: StreamEvent) => void,
	onToolResult?: (round: number, summary: string) => void,
	signal?: AbortSignal,
): Promise<EditorLoopResult> {
	let current = source;
	let editCount = 0;

	const messages: DomainMessage[] = [
		{ type: "system", content: editorAgentPrompt },
		{
			type: "user_text",
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
		if (signal?.aborted) {
			return {
				content: current,
				feedback: null,
				error: "Editor loop aborted",
				rounds: round,
			};
		}

		const acc = new StreamAccumulator();
		let message: ReturnType<StreamAccumulator["toMessage"]>;
		try {
			for await (const event of editorClient.stream(
				{
					messages,
					tools: EDITOR_TOOLS,
					toolChoice: "required",
				},
				signal,
			)) {
				acc.push(event);
				onEvent?.(round, event);
			}
			message = acc.toMessage();
		} catch (err) {
			return {
				content: current,
				feedback: null,
				error: `Editor LLM error: ${err instanceof Error ? err.message : String(err)}`,
				rounds: round + 1,
			};
		}

		if (message.toolCalls.length === 0) {
			return {
				content: current,
				feedback: null,
				error: "Editor LLM returned no tool calls",
				rounds: round + 1,
			};
		}

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
			type: "generic_tool_call",
			content: message.content ?? "",
			toolCalls: parsedToolCalls
				.filter((p) => p.args !== null)
				.map((p) => ({
					id: p.tc.toolCallId,
					tool: p.tc.toolName,
					args: p.args!,
				})),
		});

		for (const { tc, args } of parsedToolCalls) {
			const name = tc.toolName;
			if (args === null) {
				messages.push(
					toolResult(
						tc.toolCallId,
						name,
						"Error: Failed to parse tool arguments as JSON.",
					),
				);
				onToolResult?.(round, "parse error");
				continue;
			}

			switch (name) {
				case "str_replace": {
					const oldStr = String(args.old_string ?? "");
					const newStr = String(args.new_string ?? "");
					const expectedMatches =
						typeof args.expected_matches === "number"
							? args.expected_matches
							: 1;

					if (!oldStr) {
						messages.push(
							toolResult(
								tc.toolCallId,
								name,
								"Error: old_string cannot be empty.",
							),
						);
						onToolResult?.(round, "str_replace → old_string empty");
						break;
					}

					const result = applySingleOp(
						current,
						oldStr,
						newStr,
						expectedMatches,
					);
					if (result.ok) {
						current = result.content;
						editCount++;
						const context = getReplacementContext(current, newStr);
						messages.push(
							toolResult(
								tc.toolCallId,
								name,
								`OK: Replacement applied (edit #${editCount}).\n${context}`,
							),
						);
						const oldLines = oldStr.split("\n").length;
						const newLines = newStr.split("\n").length;
						const addedLines = Math.max(0, newLines - oldLines);
						const removedLines = Math.max(0, oldLines - newLines);
						const lineStats =
							[
								removedLines > 0 ? `-${removedLines}` : null,
								addedLines > 0 ? `+${addedLines}` : null,
							]
								.filter(Boolean)
								.join(" ") || "±0";
						onToolResult?.(
							round,
							`str_replace → edit #${editCount} (${lineStats} lines)`,
						);
					} else {
						messages.push(
							toolResult(
								tc.toolCallId,
								name,
								[
									`Error: ${result.error}`,
									"",
									"Check whitespace, indentation, and character-for-character accuracy.",
									"Call view_file to see the current file content.",
								].join("\n"),
							),
						);
						onToolResult?.(round, `str_replace → ${result.error}`);
					}
					break;
				}

				case "view_file": {
					const startLine =
						typeof args.start_line === "number" ? args.start_line : undefined;
					const endLine =
						typeof args.end_line === "number" ? args.end_line : undefined;

					const lines = current.split("\n");

					if (startLine !== undefined || endLine !== undefined) {
						const start = Math.max(1, startLine ?? 1);
						const end = Math.min(lines.length, endLine ?? lines.length);

						if (start > end) {
							messages.push(
								toolResult(
									tc.toolCallId,
									name,
									`Error: Invalid line range: start_line (${start}) > end_line (${end}).`,
								),
							);
							onToolResult?.(round, "view_file → invalid range");
							break;
						}

						const numberedLines = lines
							.slice(start - 1, end)
							.map((line, i) => `${start + i}| ${line}`)
							.join("\n");

						messages.push(
							toolResult(
								tc.toolCallId,
								name,
								`<source_file lines="${start}-${end}" total="${lines.length}">\n${numberedLines}\n</source_file>`,
							),
						);
					} else {
						messages.push(
							toolResult(
								tc.toolCallId,
								name,
								`<source_file>\n${current}\n</source_file>`,
							),
						);
					}
					if (startLine !== undefined || endLine !== undefined) {
						const s = Math.max(1, startLine ?? 1);
						const e = Math.min(lines.length, endLine ?? lines.length);
						onToolResult?.(
							round,
							`view_file → L${s}-${e} (${e - s + 1} lines)`,
						);
					} else {
						onToolResult?.(round, `view_file → ok (${lines.length} lines)`);
					}
					break;
				}

				case "submit": {
					const feedback =
						typeof args.feedback === "string" && args.feedback.length > 0
							? args.feedback
							: null;

					onToolResult?.(round, feedback ? `submit\n  ${feedback}` : "submit");
					return {
						content: current,
						feedback,
						error: null,
						rounds: round + 1,
					};
				}

				default: {
					messages.push(
						toolResult(
							tc.toolCallId,
							name,
							`Error: Unknown tool "${name}". Use str_replace, view_file, or submit.`,
						),
					);
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
