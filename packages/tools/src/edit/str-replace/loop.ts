/**
 * Editor Loop — Editor LLM 多轮 str_replace 循环
 *
 * 流程：
 * 1. 发送 [system, user(source + intent)]
 * 2. Editor LLM 调用 str_replace → 执行替换 → 返回结果
 * 3. Editor LLM 调用 view_file → 返回当前文件内容
 * 4. Editor LLM 调用 submit → 提取 feedback → 退出循环
 */

import type { DomainMessage, LLMClient, StreamEvent } from "@n0n/types";
import { StreamAccumulator } from "@n0n/types";
import prompt from "./prompt.md" with { type: "text" };
import { EDITOR_TOOLS } from "./tools.ts";

const MAX_ROUNDS = 15;

export interface EditorLoopResult {
	content: string;
	feedback: string | null;
	error: string | null;
	rounds: number;
}

// ── 辅助函数 ──

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

function countOccurrences(text: string, pattern: string): number {
	if (pattern.length === 0) return 0;
	let count = 0;
	let pos = text.indexOf(pattern, 0);
	while (pos !== -1) {
		count++;
		pos = text.indexOf(pattern, pos + pattern.length);
	}
	return count;
}

/**
 * 应用单次 search/replace 操作。
 * 归一化 CRLF 换行符，确保 LLM 生成的 \n 能匹配源文件的 \r\n。
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

// ── Editor Loop ──

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
		{ type: "system", content: prompt },
		{
			type: "generic_user_text",
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
				{ messages, tools: EDITOR_TOOLS, toolChoice: "required" },
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

		messages.push({
			type: "generic_tool_call",
			content: message.content ?? "",
			toolCalls: parsedToolCalls
				.filter((p) => p.args !== null)
				.map((p) => ({
					id: p.tc.toolCallId,
					tool: p.tc.toolName,
					// biome-ignore lint/style/noNonNullAssertion: filtered above
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
						const numbered = lines
							.slice(start - 1, end)
							.map((line, i) => `${start + i}| ${line}`)
							.join("\n");
						messages.push(
							toolResult(
								tc.toolCallId,
								name,
								`<source_file lines="${start}-${end}" total="${lines.length}">\n${numbered}\n</source_file>`,
							),
						);
						onToolResult?.(
							round,
							`view_file → L${start}-${end} (${end - start + 1} lines)`,
						);
					} else {
						messages.push(
							toolResult(
								tc.toolCallId,
								name,
								`<source_file>\n${current}\n</source_file>`,
							),
						);
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
					return { content: current, feedback, error: null, rounds: round + 1 };
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
