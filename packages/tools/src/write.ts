/**
 * write 工具 — 文件创建/覆盖
 *
 * 纯文件写入，不含修改逻辑（修改由 edit 工具负责）。
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { LLMToolDefinition, WriteToolResult } from "@n0n/types";
import { z } from "zod";

/** write 工具参数 schema */
export const WriteArgsSchema = z.object({
	path: z.string(),
	content: z.string(),
});

export type WriteArgs = z.infer<typeof WriteArgsSchema>;

export const WRITE_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "write",
		description:
			"Create or overwrite a file with the given content. Directories are created automatically. For modifying existing files, use the edit tool instead.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to project root",
				},
				content: {
					type: "string",
					description: "Complete file content to write",
				},
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
	},
};

export async function writeTool(
	callId: string,
	args: WriteArgs,
): Promise<WriteToolResult> {
	const filePath = resolve(args.path);

	try {
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		await Bun.write(filePath, args.content);
		return {
			type: "tool_result",
			callId,
			tool: "write",
			path: args.path,
			success: true,
			error: null,
		};
	} catch (err) {
		return {
			type: "tool_result",
			callId,
			tool: "write",
			path: args.path,
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
