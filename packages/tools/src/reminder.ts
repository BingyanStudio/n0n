/**
 * reminder 工具 — 为 agent 自己设置延迟提醒
 */

import type {
	LLMToolDefinition,
	ReminderToolArgs,
	ReminderToolResult,
} from "@n0n/types";
import { z } from "zod";

/** reminder 工具参数 schema — 运行时校验 LLM 传入的参数 */
export const ReminderArgsSchema = z.object({
	content: z.string(),
	delay: z.number().optional(),
});

export type ReminderArgs = z.infer<typeof ReminderArgsSchema>;

// 编译期校验：Zod schema 推断类型必须与 @n0n/types 中的接口兼容
type _AssertReminderArgs = ReminderArgs extends ReminderToolArgs ? true : never;
type _AssertReminderArgsReverse = ReminderToolArgs extends ReminderArgs
	? true
	: never;
const _checkReminderArgs: _AssertReminderArgs & _AssertReminderArgsReverse =
	true;

export const REMINDER_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "reminder",
		description: [
			"Set a memo/reminder for yourself (overwrites any previous reminder — only one active at a time).",
			"The content will be injected as a user message after N rounds.",
			"Usage: After breaking down the task into OKR (Objectives & Key Results), create a reminder summarizing:",
			"  1. The overall Objective",
			"  2. Key Results (checklist of what remains)",
			"  3. Current progress and next step",
			"When a reminder fires, you MUST set a new reminder (with updated progress) alongside your next tool call.",
		].join("\n"),
		parameters: {
			type: "object",
			properties: {
				content: {
					type: "string",
					description:
						"Reminder content: include OKR summary, progress status, and next steps",
				},
				delay: {
					type: "number",
					description: "Number of rounds before reminder appears (default: 7)",
				},
			},
			required: ["content"],
			additionalProperties: false,
		},
	},
};

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
	reminders.length = 0;
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
