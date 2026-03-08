/**
 * write 工具 — 文件创建/覆盖
 *
 * 纯文件写入，不含修改逻辑（修改由 edit 工具负责）。
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
	LLMToolDefinition,
	WriteToolArgs,
	WriteToolResult,
} from "@n0n/types";
import { z } from "zod";

/** write 工具参数 schema */
export const WriteArgsSchema = z.object({
	path: z.string(),
	content: z.string(),
});

export type WriteArgs = z.infer<typeof WriteArgsSchema>;

// 编译期校验：Zod schema 推断类型必须与 @n0n/types 中的接口兼容
type _AssertWriteArgs = WriteArgs extends WriteToolArgs ? true : never;
type _AssertWriteArgsReverse = WriteToolArgs extends WriteArgs ? true : never;
const _checkWriteArgs: _AssertWriteArgs & _AssertWriteArgsReverse = true;

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
	workspace: string,
): Promise<WriteToolResult> {
	const filePath = isAbsolute(args.path)
		? args.path
		: resolve(workspace, args.path);

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
