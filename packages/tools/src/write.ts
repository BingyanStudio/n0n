/**
 * write 工具 — 文件创建/覆盖
 *
 * 纯文件写入，不含修改逻辑（修改由 edit 工具负责）。
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { jsonSchema, tool } from "@n0n/llm";
import type { WriteToolCall, WriteToolResult } from "@n0n/types";

export { WriteArgsSchema } from "@n0n/types";

export const WRITE_TOOL_DEFINITION = tool({
	description:
		"Create or overwrite a file with the given content. Directories are created automatically. For modifying existing files, use the edit tool instead.",
	inputSchema: jsonSchema({
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
	}),
});

export async function writeTool(
	call: WriteToolCall,
	workspace: string,
): Promise<WriteToolResult> {
	const filePath = isAbsolute(call.args.path)
		? call.args.path
		: resolve(workspace, call.args.path);

	try {
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		await Bun.write(filePath, call.args.content);
		return {
			type: "tool_result",
			tool: "write" as const,
			call,
			success: true,
			error: null,
		};
	} catch (err) {
		return {
			type: "tool_result",
			tool: "write" as const,
			call,
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
