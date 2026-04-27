/**
 * reminder tool result 格式化 — 含 anti-few-shot 变体
 */

import type { ReminderToolResult } from "@n0n/types";
import type { TagAdapter } from "./utils.ts";
import { pick } from "./utils.ts";

const templates = [
	(est: number) =>
		`Reminder set. Estimate: ${est} rounds for next step. A <reminder> will appear when it expires.`,
	(est: number) =>
		`Reminder saved (fires in ~${est} rounds). You'll see a <reminder> when it's time.`,
	(est: number) =>
		`Got it — reminder scheduled, estimated ${est} rounds out. A <reminder> tag will notify you.`,
];

export function formatReminderResult(
	msg: ReminderToolResult,
	tags: TagAdapter,
	msgIndex: number,
): string {
	const estimate = msg.call.args.estimate ?? 7;
	const tpl = pick(templates, msgIndex);
	return tags.wrapTag("result", tpl(estimate));
}
