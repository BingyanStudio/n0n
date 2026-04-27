/**
 * submit tool result 格式化 — 含 anti-few-shot 变体
 */

import type { SubmitToolResult } from "@n0n/types";
import type { TagAdapter } from "./utils.ts";
import { pick } from "./utils.ts";

const successTemplates = [
	"Submitted successfully.",
	"Submission received.",
	"Result submitted.",
];

export function formatSubmitResult(
	msg: SubmitToolResult,
	tags: TagAdapter,
	msgIndex: number,
): string {
	const text = pick(successTemplates, msgIndex);
	const parts = [tags.wrapTag("result", text)];
	if (msg.userResponse) {
		parts.push(tags.wrapTag("user_response", msg.userResponse));
	}
	return parts.join("\n");
}
