/**
 * write 工具 — 文件创建/覆盖
 *
 * 纯文件写入，不含修改逻辑（修改由 edit 工具负责）。
 *
 * WriteToolResult 是四态判别联合（status 字段）：
 * - completed: 正常写入成功
 * - failed: 写入失败（IO 错误等）
 * - recovered: 从截断恢复后写入成功（内容不完整）
 * - recover_failed: 从截断恢复失败（参数无法解析）
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
	DomainMessage,
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

/** 正常写入（非截断恢复） */
export async function writeTool(
	call: WriteToolCall,
	workspace: string,
): Promise<WriteToolResult> {
	return writeFile(call, workspace, "completed");
}

/** 截断恢复写入（内容不完整） */
export async function writeToolRecovered(
	call: WriteToolCall,
	workspace: string,
): Promise<WriteToolResult> {
	return writeFile(call, workspace, "recovered");
}

/** 统一写入实现，status 由调用方决定 */
async function writeFile(
	call: WriteToolCall,
	workspace: string,
	successStatus: "completed" | "recovered",
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
			status: successStatus,
		};
	} catch (err) {
		// 截断恢复写入也可能失败（权限等），统一用 recover_failed 或 failed
		const errorStatus = successStatus === "recovered" ? "recover_failed" : "failed";
		return {
			type: "tool_result",
			tool: "write" as const,
			call,
			status: errorStatus,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ── 截断恢复 ──

/**
 * 创建 write 工具的截断恢复函数（闭包绑定 workspace）。
 * 恢复参数 → 执行写入 → 返回 {call, result} 对。
 */
export function makeWriteRecover(workspace: string) {
	return async (
		toolCallId: string,
		partialJson: string,
	): Promise<{ call: ToolCallRecord; result: DomainMessage } | null> => {
		const extracted = tryExtractPartialWrite(partialJson);
		if (!extracted) return null;

		const call: WriteToolCall = {
			id: toolCallId,
			tool: "write",
			args: { path: extracted.path, content: extracted.content },
		};
		const result = await writeToolRecovered(call, workspace);
		return { call, result };
	};
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

	// 从 content 值的开始引号之后扫描，寻找未转义的闭合引号
	const afterQuote = partialJson.slice(valueStart + 1);
	let rawContent: string;

	// 扫描闭合引号：逐字符检查，跳过 \" 转义
	let closeIdx = -1;
	for (let i = 0; i < afterQuote.length; i++) {
		if (afterQuote[i] === '\\') { i++; continue; } // 跳过转义字符
		if (afterQuote[i] === '"') { closeIdx = i; break; }
	}

	if (closeIdx !== -1) {
		// 找到闭合引号：截取引号之前的内容（完整 content 值）
		rawContent = afterQuote.slice(0, closeIdx);
	} else {
		// 未找到闭合引号：content 确实被截断，取到末尾并清理尾部不完整转义
		rawContent = afterQuote.replace(/\\?$/, "");
	}

	const content = rawContent
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\r/g, "\r")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");

	return { path, content };
}
