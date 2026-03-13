/**
 * edit 工具 — 基于行号的文件内容修改
 *
 * 通过指定 startLine / endLine 定位修改范围，用 content 替换该范围。
 * 消除了 search-and-replace 模式中旧内容重复出现的偏见问题：
 * 模型不再需要复现旧代码来定位编辑位置，只需指定行号范围和新内容。
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
	EditToolCall,
	EditToolResult,
	LLMToolDefinition,
} from "@n0n/types";

export { EditArgsSchema } from "@n0n/types";

export const EDIT_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "edit",
		description:
			"Edit a file by replacing a line range with new content. Specify startLine and endLine (1-based, inclusive) to define the range to replace. The file must already exist.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to project root",
				},
				startLine: {
					type: "number",
					description: "First line to replace (1-based, inclusive)",
				},
				endLine: {
					type: "number",
					description:
						"Last line to replace (1-based, inclusive). Use same value as startLine to replace a single line.",
				},
				content: {
					type: "string",
					description:
						"New content to insert in place of the specified line range",
				},
			},
			required: ["path", "startLine", "endLine", "content"],
			additionalProperties: false,
		},
	},
};

export async function editTool(
	call: EditToolCall,
	workspace: string,
): Promise<EditToolResult> {
	const filePath = isAbsolute(call.args.path)
		? call.args.path
		: resolve(workspace, call.args.path);
	const { startLine, endLine, content } = call.args;

	try {
		if (!existsSync(filePath)) {
			return {
				type: "tool_result",
				tool: "edit" as const,
				call,
				replacedCount: 0,
				success: false,
				error: `File not found: ${call.args.path}`,
			};
		}

		// Validate line numbers
		if (startLine < 1 || endLine < 1) {
			return {
				type: "tool_result",
				tool: "edit" as const,
				call,
				replacedCount: 0,
				success: false,
				error: `Line numbers must be >= 1 (got startLine=${startLine}, endLine=${endLine})`,
			};
		}
		if (startLine > endLine) {
			return {
				type: "tool_result",
				tool: "edit" as const,
				call,
				replacedCount: 0,
				success: false,
				error: `startLine (${startLine}) must be <= endLine (${endLine})`,
			};
		}

		const fileContent = await Bun.file(filePath).text();
		const lines = fileContent.split("\n");

		if (startLine > lines.length) {
			return {
				type: "tool_result",
				tool: "edit" as const,
				call,
				replacedCount: 0,
				success: false,
				error: `startLine (${startLine}) exceeds file length (${lines.length} lines)`,
			};
		}

		// Clamp endLine to file length (allow replacing to end of file)
		const effectiveEndLine = Math.min(endLine, lines.length);
		const replacedCount = effectiveEndLine - startLine + 1;

		// Build new content: lines before range + new content + lines after range
		const before = lines.slice(0, startLine - 1);
		const after = lines.slice(effectiveEndLine);
		const newLines = content.length > 0 ? content.split("\n") : [];
		const newContent = [...before, ...newLines, ...after].join("\n");

		await Bun.write(filePath, newContent);

		return {
			type: "tool_result",
			tool: "edit" as const,
			call,
			replacedCount,
			success: true,
			error: null,
		};
	} catch (err) {
		return {
			type: "tool_result",
			tool: "edit" as const,
			call,
			replacedCount: 0,
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
