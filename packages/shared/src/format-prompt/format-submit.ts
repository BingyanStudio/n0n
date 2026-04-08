/**
 * submit tool result 格式化 — 含 anti-few-shot 变体
 */

import type { SubmitToolResult } from "@n0n/types";
import { pick, wrapTag } from "./utils.ts";

const successTemplates = [
	"Submitted successfully.",
	"Submission received.",
	"Result submitted.",
];

export function formatSubmitResult(
	msg: SubmitToolResult,
	model: string,
	msgIndex: number,
): string {
	const text = pick(successTemplates, msgIndex);
	const parts = [wrapTag("result", text, model)];
	if (msg.userResponse) {
		parts.push(wrapTag("user_response", msg.userResponse, model));
	}
	return parts.join("\n");
}
