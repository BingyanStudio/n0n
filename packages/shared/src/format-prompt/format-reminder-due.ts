/**
 * reminder:due 格式化 — 含 anti-few-shot 变体
 */

import type { ReminderDueMessage } from "@n0n/types";
import type { TagAdapter } from "./utils.ts";
import { pick } from "./utils.ts";

const templates = [
	(est: number, content: string) =>
		`Your reminder has fired (estimate was ${est} rounds). Review and recalibrate:\n${content}`,
	(est: number, content: string) =>
		`Reminder triggered (originally set for ~${est} rounds). Check progress:\n${content}`,
	(est: number, content: string) =>
		`Scheduled reminder (est. ${est} rounds) — time to review:\n${content}`,
];

export function formatReminderDue(
	msg: ReminderDueMessage,
	tags: TagAdapter,
	msgIndex: number,
): string {
	const tpl = pick(templates, msgIndex);
	return tags.wrapTag("reminder", tpl(msg.originalEstimate, msg.content));
}
