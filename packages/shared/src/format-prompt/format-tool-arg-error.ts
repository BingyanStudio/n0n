/**
 * tool_arg_error 格式化 — 含 anti-few-shot 变体
 */

import type { ToolArgErrorMessage } from "@n0n/types";
import type { TagAdapter } from "./utils.ts";
import { pick } from "./utils.ts";

const prefixTemplates = [
	(error: string) => `Invalid tool arguments: ${error}`,
	(error: string) => `Tool argument validation failed: ${error}`,
	(error: string) => `Bad tool args — ${error}`,
];

export function formatToolArgError(
	msg: ToolArgErrorMessage,
	tags: TagAdapter,
	msgIndex: number,
): string {
	const tpl = pick(prefixTemplates, msgIndex);
	let content = tpl(msg.error);
	if (msg.schema) {
		content += `\n\nExpected schema:\n${JSON.stringify(msg.schema, null, 2)}`;
	}
	return tags.wrapTag("error", content);
}
