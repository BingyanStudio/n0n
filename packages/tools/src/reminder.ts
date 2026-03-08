/**
 * reminder 工具 — 为 agent 自己设置延迟提醒
 */

import type {
	LLMToolDefinition,
	ReminderToolCall,
	ReminderToolResult,
} from "@n0n/types";

export { ReminderArgsSchema } from "@n0n/types";

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
	call: ReminderToolCall,
	reminders: PendingReminder[],
): ReminderToolResult {
	const delay = call.args.delay ?? 7;
	reminders.length = 0;
	reminders.push({ content: call.args.content, roundsLeft: delay });

	return {
		type: "tool_result",
		tool: "reminder" as const,
		call,
		acknowledged: true,
	};
}
