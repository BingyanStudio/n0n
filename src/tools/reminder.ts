/**
 * reminder 工具 — 为 agent 自己设置延迟提醒
 *
 * 提醒存储在内存中，由 agent loop 在适当的轮次注入。
 */

import type { ReminderToolResult } from "../types/domain.ts";

interface ReminderArgs {
	content: string;
	delay?: number;
}

export interface PendingReminder {
	content: string;
	roundsLeft: number;
}

export function reminderTool(
	callId: string,
	args: ReminderArgs,
	reminders: PendingReminder[],
): ReminderToolResult {
	const delay = args.delay ?? 7;
	reminders.push({ content: args.content, roundsLeft: delay });

	return {
		type: "tool_result",
		callId,
		tool: "reminder",
		content: args.content,
		delay,
		acknowledged: true,
	};
}
