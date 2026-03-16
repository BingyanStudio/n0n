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
 * - 验证闭环：返回 diff 给主模型确认
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

// ── Shadow Edit System Prompt ──

const SHADOW_SYSTEM_PROMPT = `You are a precise code editor. Given a source file and an edit intent, output a JSON array of search/replace operations.

RULES:
1. Each operation: { "search": "exact text to find", "replace": "replacement text" }
2. "search" must be an EXACT substring of the source file (character-for-character match including whitespace and indentation)
3. "search" should be the MINIMAL unique fragment that unambiguously identifies the target location
4. "replace" is the complete replacement for the matched text
5. Only modify what the intent describes — leave everything else unchanged
6. For deletions, use "replace": ""
7. For insertions after X, include X in "search" and X + new content in "replace"
8. Output ONLY the JSON array, no explanation, no markdown fences

EXAMPLE:
Intent: "Change timeout from 5000 to 10000"
Source contains: "const TIMEOUT = 5000;"
Output: [{"search": "const TIMEOUT = 5000;", "replace": "const TIMEOUT = 10000;"}]

EXAMPLE:
Intent: "Add import for readFile after the fs import"
Source contains: "import { writeFile } from 'fs';"
Output: [{"search": "import { writeFile } from 'fs';", "replace": "import { writeFile } from 'fs';\\nimport { readFile } from 'fs/promises';"}]`;

// ── Types ──

interface SearchReplaceOp {
	search: string;
	replace: string;
}

// ── Core Logic ──

/**
 * 调用 Editor LLM 将编辑意图解析为 search/replace 操作序列
 */
async function resolveIntent(
	source: string,
	intent: string,
	editorLlm: LLMConfig,
): Promise<{ ops: SearchReplaceOp[]; error?: string }> {
	try {
		const response = await chatCompletion(
			{
				messages: [
					{ role: "system", content: SHADOW_SYSTEM_PROMPT },
					{
						role: "user",
						content: `<source_file>\n${source}\n</source_file>\n\n<edit_intent>\n${intent}\n</edit_intent>`,
					},
				],
				temperature: 0,
			},
			editorLlm,
		);

		const content = response.choices[0]?.message?.content;
		if (!content) {
			return { ops: [], error: "Editor LLM returned empty response" };
		}

		// 提取 JSON（可能被 markdown 代码块包裹）
		const jsonStr = content
			.replace(/^```(?:json)?\s*/m, "")
			.replace(/\s*```\s*$/m, "")
			.trim();

		const parsed = JSON.parse(jsonStr);
		if (!Array.isArray(parsed)) {
			return { ops: [], error: `Editor LLM returned non-array: ${typeof parsed}` };
		}

		const ops: SearchReplaceOp[] = [];
		for (const item of parsed) {
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
 * 生成简洁的 unified diff 摘要
 */
export function computeDiff(oldContent: string, newContent: string, path: string): string {
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

		// 找到差异区域
		const contextStart = Math.max(0, i - 2);
		let oldEnd = i;
		let newEnd = j;

		// 向前扫描找到差异结束
		while (oldEnd < oldLines.length || newEnd < newLines.length) {
			if (
				oldEnd < oldLines.length &&
				newEnd < newLines.length &&
				oldLines[oldEnd] === newLines[newEnd]
			) {
				// 检查是否有足够的连续匹配行（3行）表示差异结束
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

		// 输出 chunk
		chunks.push(`@@ -${contextStart + 1},${oldEnd - contextStart} +${contextStart + 1},${newEnd - contextStart} @@`);

		// 上下文行
		for (let c = contextStart; c < i; c++) {
			chunks.push(` ${oldLines[c]}`);
		}
		// 删除的行
		for (let c = i; c < oldEnd; c++) {
			chunks.push(`-${oldLines[c]}`);
		}
		// 新增的行
		for (let c = j; c < newEnd; c++) {
			chunks.push(`+${newLines[c]}`);
		}

		i = oldEnd;
		j = newEnd;
	}

	if (chunks.length === 0) return "(no changes)";

	const header = `--- a/${path}\n+++ b/${path}`;
	return `${header}\n${chunks.join("\n")}`;
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
			return fail(
				`No operations applied. Errors:\n${errors.join("\n")}`,
			);
		}

		// 3. 写入文件
		writeFileSync(filePath, newContent, "utf8");

		// 4. 生成 diff
		const diff = computeDiff(source, newContent, call.args.path);

		// 5. 如果有部分失败，在 diff 中附加警告
		const warnings = errors.length > 0
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
