/**
 * write 工具 — 文件创建/覆盖
 *
 * 纯文件写入，不含修改逻辑（修改由 edit 工具负责）。
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
	ToolCallRecord,
	ToolDefinition,
	WriteToolCall,
	WriteToolResult,
} from "@n0n/types";

export { WriteArgsSchema } from "@n0n/types";

export const WRITE_TOOL_DEFINITION: ToolDefinition = {
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
};

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

// ── 截断恢复 ──

/**
 * 从截断的 write 工具 JSON 参数中恢复出可执行的 ToolCallRecord。
 * 用作 ToolEntry.recover，由截断恢复框架调用。
 */
export function recoverPartialWrite(
	toolCallId: string,
	partialJson: string,
): ToolCallRecord | null {
	const extracted = tryExtractPartialWrite(partialJson);
	if (!extracted) return null;
	return {
		id: toolCallId,
		tool: "write",
		args: { path: extracted.path, content: extracted.content },
	} as ToolCallRecord;
}

/**
 * 尝试从截断的 write 工具 JSON 参数中提取 path 和 content。
 *
 * write 参数格式为 {"path":"...","content":"..."}。
 * 当 content 被 max_tokens 截断时，JSON 不完整，但 path 和部分 content 仍可恢复。
 * 返回 null 表示无法提取（path 未找到）。
 *
 * 注意：当前只处理基础 JSON 转义（\n \t \r \" \\），
 * 未处理 \uXXXX unicode 转义。目前未观测到实际问题。
 */
function tryExtractPartialWrite(
	partialJson: string,
): { path: string; content: string } | null {
	const pathMatch = partialJson.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (!pathMatch?.[1]) return null;

	const path = pathMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	if (!path) return null;

	const contentStart = partialJson.indexOf('"content"');
	if (contentStart === -1) return { path, content: "" };

	const valueStart = partialJson.indexOf(
		'"',
		contentStart + '"content"'.length + 1,
	);
	if (valueStart === -1) return { path, content: "" };

	const rawContent = partialJson.slice(valueStart + 1);
	const cleaned = rawContent.replace(/\\?$/, "");
	const content = cleaned
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\r/g, "\r")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");

	return { path, content };
}
