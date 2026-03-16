/**
 * edit 工具 — 影子编辑（Shadow Edit）
 *
 * 主模型用自由文本表达编辑意图（intent），影子层（Editor LLM）
 * 负责理解意图并生成精确的 search/replace 操作来修改文件。
 *
 * 架构：主模型 → intent → Editor LLM → search/replace → 文件
 *
 * 设计原则：
 * - 内容即地址：用内容本身定位，而非外部坐标
 * - 意图驱动：主模型只需表达"改什么"，不需要关心"怎么精确定位"
 * - 验证闭环：返回变更后的最终状态给主模型确认
 * - 重试纠错：Editor LLM 出错时反馈错误信息并重试
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { LLMConfig } from "@n0n/llm";
import { chatCompletion } from "@n0n/llm";
import type {
	EditToolCall,
	EditToolResult,
	LLMRequestMessage,
	LLMToolDefinition,
} from "@n0n/types";
import editDescription from "./descriptions/edit.md" with { type: "text" };
import editorAgentPrompt from "./descriptions/editor-agent.md" with { type: "text" };

export { EditArgsSchema } from "@n0n/types";

export const EDIT_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "edit",
		description: editDescription,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to project root",
				},
				intent: {
					type: "string",
					description:
						"Edit intent in free-form text: natural language description, code snippets, or a mix of both. Describe what to change and where.",
				},
			},
			required: ["path", "intent"],
			additionalProperties: false,
		},
	},
};

// ── Editor LLM 工具定义 ──

const EDITOR_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "apply_edits",
		description:
			"Apply a list of search/replace operations to the source file. Each operation finds an exact substring and replaces it.",
		parameters: {
			type: "object",
			properties: {
				operations: {
					type: "array" as unknown as "object",
					items: {
						type: "object",
						properties: {
							search: {
								type: "string",
								description:
									"Exact substring to find in the source file (character-for-character match including whitespace)",
							},
							replace: {
								type: "string",
								description:
									"Replacement text. Use empty string for deletions.",
							},
						},
						required: ["search", "replace"],
					},
					description: "List of search/replace operations to apply sequentially",
				},
			},
			required: ["operations"],
			additionalProperties: false,
		},
	},
};

// ── Types ──

interface SearchReplaceOp {
	search: string;
	replace: string;
}

/** 最大重试次数（含首次尝试） */
const MAX_ATTEMPTS = 3;

// ── Core Logic ──

/**
 * 从 tool_calls 或 content 中提取 search/replace 操作
 */
function extractOps(message: {
	content: string | null;
	tool_calls?: { function: { name: string; arguments: string } }[];
}): { ops: SearchReplaceOp[]; error?: string } {
	// 优先从 tool_calls 提取
	const toolCall = message.tool_calls?.[0];
	if (toolCall?.function.name === "apply_edits") {
		try {
			const parsed = JSON.parse(toolCall.function.arguments);
			const rawOps = parsed.operations;
			if (!Array.isArray(rawOps)) {
				return { ops: [], error: "apply_edits: operations is not an array" };
			}
			const ops = rawOps.filter(
				(item: unknown): item is SearchReplaceOp =>
					typeof item === "object" &&
					item !== null &&
					typeof (item as SearchReplaceOp).search === "string" &&
					typeof (item as SearchReplaceOp).replace === "string",
			);
			return ops.length > 0
				? { ops }
				: { ops: [], error: "apply_edits: no valid operations in array" };
		} catch (e) {
			return {
				ops: [],
				error: `apply_edits: failed to parse arguments: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	// Fallback: 从 content 解析 JSON
	if (message.content) {
		return parseOpsFromContent(message.content);
	}

	return { ops: [], error: "No tool call and no content in response" };
}

/**
 * Fallback: 从纯文本 content 中解析 JSON 操作列表
 */
function parseOpsFromContent(
	content: string,
): { ops: SearchReplaceOp[]; error?: string } {
	try {
		const jsonStr = content
			.replace(/^```(?:json)?\s*/m, "")
			.replace(/\s*```\s*$/m, "")
			.trim();
		const parsed = JSON.parse(jsonStr);
		const rawOps = Array.isArray(parsed) ? parsed : parsed?.operations;
		if (!Array.isArray(rawOps)) {
			return { ops: [], error: "Could not parse operations from content" };
		}
		const ops = rawOps.filter(
			(item: unknown): item is SearchReplaceOp =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as SearchReplaceOp).search === "string" &&
				typeof (item as SearchReplaceOp).replace === "string",
		);
		return ops.length > 0
			? { ops }
			: { ops: [], error: "No valid operations in content" };
	} catch {
		return { ops: [], error: "Failed to parse JSON from content" };
	}
}

/**
 * 应用 search/replace 操作序列到源文件内容
 */
export function applyOps(
	source: string,
	ops: SearchReplaceOp[],
): { content: string; applied: number; errors: string[] } {
	let content = source;
	let applied = 0;
	const errors: string[] = [];

	for (const op of ops) {
		const idx = content.indexOf(op.search);
		if (idx === -1) {
			errors.push(
				`Search text not found: "${op.search.length > 80 ? `${op.search.slice(0, 80)}...` : op.search}"`,
			);
			continue;
		}

		const secondIdx = content.indexOf(op.search, idx + 1);
		if (secondIdx !== -1) {
			errors.push(
				`Search text matches multiple locations: "${op.search.length > 80 ? `${op.search.slice(0, 80)}...` : op.search}"`,
			);
			continue;
		}

		content =
			content.slice(0, idx) + op.replace + content.slice(idx + op.search.length);
		applied++;
	}

	return { content, applied, errors };
}

/**
 * 多轮对话循环：调用 Editor LLM，验证结果，出错时反馈并重试。
 *
 * 流程：
 * 1. 发送 [system, user(source + intent)]
 * 2. Editor LLM 返回 tool_call → 解析 ops → applyOps 验证
 * 3. 全部成功 → 返回新内容
 * 4. 有失败 → 追加 assistant + tool_result(错误) 到 messages，重试
 * 5. 没调用工具 → 追加 user(错误提示)，重试
 * 6. 达到上限 → 返回最后的错误
 */
async function resolveAndApply(
	source: string,
	intent: string,
	editorLlm: LLMConfig,
): Promise<{ content: string; error?: string }> {
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
				"",
				"Call the `apply_edits` tool with the exact search/replace operations needed. You MUST call the tool.",
			].join("\n"),
		},
	];

	let lastError = "";

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			const response = await chatCompletion(
				{
					messages,
					tools: [EDITOR_TOOL_DEFINITION],
					tool_choice: "required",
					temperature: 0,
				},
				editorLlm,
			);

			const message = response.choices[0]?.message;
			if (!message) {
				lastError = "Editor LLM returned empty response";
				messages.push({
					role: "user",
					content: `Error: ${lastError}. Please call the apply_edits tool.`,
				});
				continue;
			}

			// 提取操作
			const { ops, error: extractError } = extractOps(message);
			if (extractError || ops.length === 0) {
				lastError = extractError ?? "No operations extracted";

				// 追加 assistant 消息（保持对话连贯）
				messages.push({
					role: "assistant",
					content: message.content,
					tool_calls: message.tool_calls,
				});

				// 如果有 tool_call，追加 tool result 反馈错误
				if (message.tool_calls?.[0]) {
					messages.push({
						role: "tool",
						content: `Error: ${lastError}. Review the source file and fix your operations.`,
						tool_call_id: message.tool_calls[0].id,
					});
				} else {
					messages.push({
						role: "user",
						content: `Error: ${lastError}. You MUST call the apply_edits tool. Do not respond with text.`,
					});
				}
				continue;
			}

			// 应用操作并验证
			const { content, applied, errors } = applyOps(source, ops);

			if (applied === 0) {
				lastError = `All operations failed:\n${errors.join("\n")}`;

				messages.push({
					role: "assistant",
					content: message.content,
					tool_calls: message.tool_calls,
				});
				if (message.tool_calls?.[0]) {
					messages.push({
						role: "tool",
						content: [
							`Error: ${lastError}`,
							"",
							"Your search strings did not match the source file exactly.",
							"Check whitespace, indentation, and character-for-character accuracy.",
							"Here is the current source file for reference:",
							"<source_file>",
							source,
							"</source_file>",
							"",
							"Call apply_edits again with corrected operations.",
						].join("\n"),
						tool_call_id: message.tool_calls[0].id,
					});
				}
				continue;
			}

			if (errors.length > 0) {
				// 部分成功 — 用部分应用后的内容作为新 source 继续
				const remainingErrors = errors.join("\n");
				lastError = `${applied} operation(s) applied, ${errors.length} failed:\n${remainingErrors}`;

				messages.push({
					role: "assistant",
					content: message.content,
					tool_calls: message.tool_calls,
				});
				if (message.tool_calls?.[0]) {
					messages.push({
						role: "tool",
						content: [
							`Partial success: ${applied} applied, ${errors.length} failed:`,
							remainingErrors,
							"",
							"Here is the UPDATED source file after partial application:",
							"<source_file>",
							content,
							"</source_file>",
							"",
							"Call apply_edits again to fix the remaining failed operations.",
						].join("\n"),
						tool_call_id: message.tool_calls[0].id,
					});
				}
				// 更新 source 为部分应用后的内容
				source = content;
				continue;
			}

			// 全部成功
			return { content };
		} catch (err) {
			lastError = `Editor LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
			// 网络错误等不追加消息，直接重试
		}
	}

	return { content: source, error: `Failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}` };
}

/**
 * 生成变更摘要 — 只显示变更区域的最终状态（不显示删除内容）
 */
export function computeDiff(
	oldContent: string,
	newContent: string,
	path: string,
): string {
	if (oldContent === newContent) return "(no changes)";

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const chunks: string[] = [];

	let i = 0;
	let j = 0;

	while (i < oldLines.length || j < newLines.length) {
		if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
			i++;
			j++;
			continue;
		}

		const contextStart = Math.max(0, j - 2);

		let oldEnd = i;
		let newEnd = j;
		while (oldEnd < oldLines.length || newEnd < newLines.length) {
			if (
				oldEnd < oldLines.length &&
				newEnd < newLines.length &&
				oldLines[oldEnd] === newLines[newEnd]
			) {
				let matchCount = 0;
				while (
					oldEnd + matchCount < oldLines.length &&
					newEnd + matchCount < newLines.length &&
					oldLines[oldEnd + matchCount] === newLines[newEnd + matchCount]
				) {
					matchCount++;
					if (matchCount >= 3) break;
				}
				if (matchCount >= 3) break;
			}
			if (oldEnd < oldLines.length) oldEnd++;
			if (newEnd < newLines.length) newEnd++;
		}

		const contextEnd = Math.min(newLines.length, newEnd + 2);

		chunks.push(`@@ ${path}:${contextStart + 1}-${contextEnd} @@`);
		for (let c = contextStart; c < contextEnd; c++) {
			const prefix = c >= j && c < newEnd ? "+" : " ";
			chunks.push(`${prefix} ${c + 1} | ${newLines[c]}`);
		}

		i = oldEnd;
		j = newEnd;
	}

	return chunks.join("\n");
}

// ── Tool Entry Point ──

export async function editTool(
	call: EditToolCall,
	workspace: string,
	editorLlm: LLMConfig,
): Promise<EditToolResult> {
	const filePath = isAbsolute(call.args.path)
		? call.args.path
		: resolve(workspace, call.args.path);
	const { intent } = call.args;

	const fail = (error: string): EditToolResult => ({
		type: "tool_result",
		tool: "edit" as const,
		call,
		diff: "",
		success: false,
		error,
	});

	try {
		if (!existsSync(filePath)) return fail(`File not found: ${call.args.path}`);
		if (!intent || intent.trim().length === 0) return fail("No intent provided");

		const source = readFileSync(filePath, "utf8");

		// 多轮对话：调用 Editor LLM + 验证 + 重试
		const { content: newContent, error } = await resolveAndApply(
			source,
			intent,
			editorLlm,
		);

		if (error) return fail(error);

		// 写入文件
		writeFileSync(filePath, newContent, "utf8");

		// 生成变更摘要
		const diff = computeDiff(source, newContent, call.args.path);

		return {
			type: "tool_result",
			tool: "edit" as const,
			call,
			diff,
			success: true,
			error: null,
		};
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}
