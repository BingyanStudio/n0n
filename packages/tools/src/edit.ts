/**
 * edit 工具 — 文件内容修改（search & replace）
 *
 * 从原 write 工具中拆分出来，专注于文件修改操作。
 * write 负责创建/覆盖文件，edit 负责精确修改已有文件内容。
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { EditToolResult, LLMToolDefinition } from "@n0n/types";
import { z } from "zod";

/** edit 工具参数 schema */
export const EditArgsSchema = z.object({
	path: z.string(),
	search: z.string(),
	replace: z.string(),
	expectedMatches: z.number().optional(),
});

export type EditArgs = z.infer<typeof EditArgsSchema>;

export const EDIT_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "edit",
		description:
			"Edit a file by replacing exact text matches. The file must already exist. Use expectedMatches to assert the number of replacements.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to project root",
				},
				search: {
					type: "string",
					description: "Exact text to find in the file",
				},
				replace: {
					type: "string",
					description: "Replacement text",
				},
				expectedMatches: {
					type: "number",
					description:
						"Expected number of matches (default: 1). Mismatch = error.",
				},
			},
			required: ["path", "search", "replace"],
			additionalProperties: false,
		},
	},
};

export async function editTool(
	callId: string,
	args: EditArgs,
	workspace: string,
): Promise<EditToolResult> {
	const filePath = isAbsolute(args.path)
		? args.path
		: resolve(workspace, args.path);
	const { search, replace } = args;
	const expectedCount = args.expectedMatches ?? 1;

	try {
		if (!existsSync(filePath)) {
			return {
				type: "tool_result",
				callId,
				tool: "edit",
				path: args.path,
				searchPattern: search,
				replacedCount: 0,
				success: false,
				error: `File not found: ${args.path}`,
			};
		}

		const content = await Bun.file(filePath).text();
		let count = 0;
		let pos = 0;
		while (true) {
			const idx = content.indexOf(search, pos);
			if (idx === -1) break;
			count++;
			pos = idx + search.length;
		}

		if (count !== expectedCount) {
			return {
				type: "tool_result",
				callId,
				tool: "edit",
				path: args.path,
				searchPattern: search,
				replacedCount: count,
				success: false,
				error: `Expected ${expectedCount} match(es) but found ${count}`,
			};
		}

		const newContent = content.replaceAll(search, replace);
		await Bun.write(filePath, newContent);

		return {
			type: "tool_result",
			callId,
			tool: "edit",
			path: args.path,
			searchPattern: search,
			replacedCount: count,
			success: true,
			error: null,
		};
	} catch (err) {
		return {
			type: "tool_result",
			callId,
			tool: "edit",
			path: args.path,
			searchPattern: search,
			replacedCount: 0,
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
