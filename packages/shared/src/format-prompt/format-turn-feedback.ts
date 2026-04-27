/**
 * turn_feedback 格式化 — 含 anti-few-shot 变体
 */

import type { TurnFeedbackMessage } from "@n0n/types";
import type { TagAdapter } from "./utils.ts";
import { pick } from "./utils.ts";

const templates = [
	(status: string, type: string, detail: string) =>
		`Status: ${status} | Type: ${type}\n${detail}`,
	(status: string, type: string, detail: string) =>
		`[${status}] result_type=${type}\n${detail}`,
	(status: string, type: string, detail: string) =>
		`Outcome: ${status} (${type})\n${detail}`,
];

export function formatTurnFeedback(
	msg: TurnFeedbackMessage,
	tags: TagAdapter,
	msgIndex: number,
): string {
	const tpl = pick(templates, msgIndex);
	return tags.wrapTag(
		"turn_feedback",
		tpl(msg.status, msg.resultType, msg.detail),
	);
}
