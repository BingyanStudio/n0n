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
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { LLMConfig } from "@n0n/llm";
import { chatCompletion } from "@n0n/llm";
import type {
	EditToolCall,
	EditToolResult,
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

/** Editor LLM 调用的工具：apply_edits */
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

// ── Core Logic ──

/**
 * 调用 Editor LLM 将编辑意图解析为 search/replace 操作序列。
 * 使用 tool_choice: "required" 强制模型调用 apply_edits 工具，
 * 直接从 tool_calls 中解析结构化结果，无需 JSON 文本解析。
 */
async function resolveIntent(
	source: string,
	intent: string,
	editorLlm: LLMConfig,
): Promise<{ ops: SearchReplaceOp[]; error?: string }> {
	try {
		const userContent = [
			"<source_file>",
			source,
			"</source_file>",
			"",
			"<edit_intent>",
			intent,
			"</edit_intent>",
			"",
			"Call the `apply_edits` tool with the exact search/replace operations needed. You MUST call the tool.",
		].join("\n");

		const response = await chatCompletion(
			{
				messages: [
					{ role: "system", content: editorAgentPrompt },
					{ role: "user", content: userContent },
				],
				tools: [EDITOR_TOOL_DEFINITION],
				tool_choice: "required",
				temperature: 0,
			},
			editorLlm,
		);

		const message = response.choices[0]?.message;
		if (!message) {
			return { ops: [], error: "Editor LLM returned empty response" };
		}

		// 从 tool_calls 中提取结构化结果
		const toolCall = message.tool_calls?.[0];
		if (!toolCall || toolCall.function.name !== "apply_edits") {
			// fallback: 尝试从 content 解析（某些模型可能不遵守 tool_choice）
			if (message.content) {
				return parseOpsFromContent(message.content);
			}
			return { ops: [], error: "Editor LLM did not call apply_edits tool" };
		}

		const parsed = JSON.parse(toolCall.function.arguments);
		const rawOps = parsed.operations;
		if (!Array.isArray(rawOps)) {
			return { ops: [], error: "Editor LLM returned non-array operations" };
		}

		const ops: SearchReplaceOp[] = [];
		for (const item of rawOps) {
			if (
				typeof item === "object" &&
				item !== null &&
				typeof item.search === "string" &&
				typeof item.replace === "string"
			) {
				ops.push({ search: item.search, replace: item.replace });
			}
		}

		if (ops.length === 0) {
			return { ops: [], error: "Editor LLM returned no valid operations" };
		}

		return { ops };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ops: [], error: `Editor LLM call failed: ${msg}` };
	}
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
		// 支持 { operations: [...] } 或直接 [...]
		const rawOps = Array.isArray(parsed) ? parsed : parsed?.operations;
		if (!Array.isArray(rawOps)) {
			return { ops: [], error: "Could not parse operations from content" };
		}

		const ops: SearchReplaceOp[] = [];
		for (const item of rawOps) {
			if (
				typeof item === "object" &&
				item !== null &&
				typeof item.search === "string" &&
				typeof item.replace === "string"
			) {
				ops.push({ search: item.search, replace: item.replace });
			}
		}
		return ops.length > 0
			? { ops }
			: { ops: [], error: "No valid operations in content" };
	} catch {
		return { ops: [], error: "Failed to parse JSON from content" };
	}
}

/**
 * 应用 search/replace 操作序列到源文件内容
 * 返回修改后的内容，或错误信息
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

		// 检查唯一性：确保只有一处匹配
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
 * 生成变更摘要 — 只显示变更区域的最终状态（不显示删除内容）
 *
 * 格式：每个变更区域显示上下文行 + 新内容，用行号标注。
 * 主模型只需确认最终状态是否正确，不需要看旧内容。
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

	// 简单 LCS 差异检测：找到变更区域，只输出新内容
	let i = 0;
	let j = 0;

	while (i < oldLines.length || j < newLines.length) {
		if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
			i++;
			j++;
			continue;
		}

		// 找到差异起点，记录上下文
		const contextStart = Math.max(0, j - 2);

		// 向前扫描找到差异结束
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

		// 输出变更区域的最终状态（带行号）
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

		// 1. 调用 Editor LLM 解析意图
		const { ops, error: resolveError } = await resolveIntent(
			source,
			intent,
			editorLlm,
		);
		if (resolveError) return fail(resolveError);

		// 2. 应用 search/replace 操作
		const { content: newContent, applied, errors } = applyOps(source, ops);

		if (applied === 0) {
			return fail(`No operations applied. Errors:\n${errors.join("\n")}`);
		}

		// 3. 写入文件
		writeFileSync(filePath, newContent, "utf8");

		// 4. 生成变更摘要（只显示最终状态）
		const diff = computeDiff(source, newContent, call.args.path);

		// 5. 如果有部分失败，在 diff 中附加警告
		const warnings =
			errors.length > 0
				? `\n\n⚠️ ${errors.length} operation(s) failed:\n${errors.join("\n")}`
				: "";

		return {
			type: "tool_result",
			tool: "edit" as const,
			call,
			diff: diff + warnings,
			success: true,
			error: null,
		};
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}
