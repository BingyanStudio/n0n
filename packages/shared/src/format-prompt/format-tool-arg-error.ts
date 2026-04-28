/**
 * tool_arg_error 格式化 — 纯数据 → 提示词
 *
 * 根据 ToolError 的判别联合（kind）生成自然语言提示。
 * anti-few-shot：每种 error kind 有多个表述变体，通过 msgIndex 选择。
 */

import type { TagAdapter } from "@n0n/types";
import { pick } from "./utils.ts";

// ── 变体模板 ──

const unknownToolVariants = [
	(tool: string) =>
		`Unknown tool: '${tool}'. Available tools: exec, write, edit, reminder, submit. To read files, use the exec tool with a script.`,
	(tool: string) =>
		`Tool '${tool}' does not exist. Use one of: exec, write, edit, reminder, submit. For reading files, exec is the right choice.`,
	(tool: string) =>
		`'${tool}' is not a recognized tool. Recognized tools: exec, write, edit, reminder, submit. Use exec to read file contents.`,
];

const invalidArgsVariants = [
	(issues: string) => `Invalid tool arguments: ${issues}`,
	(issues: string) => `Tool argument validation failed: ${issues}`,
	(issues: string) => `Bad tool args — ${issues}`,
];

const truncatedRecoveryVariants = [
	() =>
		"Tool call arguments were truncated by max_tokens and could not be recovered. Please retry with a shorter response, or break the task into smaller steps.",
	() =>
		"Streaming output was cut off before tool arguments could complete. Please shorten your response or split the task.",
	() =>
		"Arguments were truncated due to output length limit. Retry with fewer tool calls or smaller arguments.",
];

const internalErrorVariants = [
	(message: string) => `Internal execution error: ${message}`,
	(message: string) => `Tool execution failed unexpectedly: ${message}`,
	(message: string) => `Unexpected error during tool execution: ${message}`,
];

// ── 格式化入口 ──

import type { ToolArgErrorMessage } from "@n0n/types";

export function formatToolArgError(
	msg: ToolArgErrorMessage,
	tags: TagAdapter,
	msgIndex: number,
): string {
	const { error: err, tool } = msg;
	let content: string;

	switch (err.kind) {
		case "unknown_tool": {
			const tpl = pick(unknownToolVariants, msgIndex);
			content = tpl(tool);
			break;
		}
		case "invalid_args": {
			const issues = err.issues
				.map((i) => `${i.path ? i.path + ": " : ""}${i.message}`)
				.join("; ");
			const tpl = pick(invalidArgsVariants, msgIndex);
			content = tpl(issues);
			if (err.schema) {
				content += `\n\nExpected schema:\n${JSON.stringify(err.schema, null, 2)}`;
			}
			break;
		}
		case "truncated_recovery": {
			const tpl = pick(truncatedRecoveryVariants, msgIndex);
			content = tpl();
			break;
		}
		case "internal_error": {
			const tpl = pick(internalErrorVariants, msgIndex);
			content = tpl(err.message);
			break;
		}
		default: {
			const _exhaustive: never = err;
			content = `Unknown error: ${JSON.stringify(err)}`;
		}
	}

	return tags.wrapTag("error", content);
}
