/**
 * tool_arg_error 格式化 — 含 anti-few-shot 变体
 */

import type { ToolArgErrorMessage } from "@n0n/types";
import { pick, wrapTag } from "./utils.ts";

const prefixTemplates = [
	(error: string) => `Invalid tool arguments: ${error}`,
	(error: string) => `Tool argument validation failed: ${error}`,
	(error: string) => `Bad tool args — ${error}`,
];

export function formatToolArgError(
	msg: ToolArgErrorMessage,
	model: string,
	msgIndex: number,
): string {
	const tpl = pick(prefixTemplates, msgIndex);
	let content = tpl(msg.error);
	if (msg.schema) {
		content += `\n\nExpected schema:\n${JSON.stringify(msg.schema, null, 2)}`;
	}
	return wrapTag("error", content, model);
}
