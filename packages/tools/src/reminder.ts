/**
 * reminder 工具 — agent 的备忘录
 *
 * 核心价值：在长任务中防止上下文丢失。
 * 模型设置 reminder 后，content 会在 estimate 轮后作为 <reminder> 重新注入，
 * 迫使模型在特定节点审视进度、校准方向。
 */

import type {
	ReminderArgs,
	ReminderToolCall,
	ReminderToolResult,
	ToolDefinition,
} from "@n0n/types";
import { ReminderArgsSchema } from "@n0n/types";
import {
	type FieldDescriptions,
	zodToParameters,
} from "./zod-to-parameters.ts";

export { ReminderArgsSchema };

const reminderDescriptions: FieldDescriptions<ReminderArgs> = {
	content:
		"Reminder content: what you've done, what remains, and what to do next.",
	estimate:
		"Rounds until this reminder fires (default: 7). 1 round = 1 tool call batch.",
};

export const REMINDER_TOOL_DEFINITION: ToolDefinition = {
	name: "reminder",
	description: [
		"Set a memo for yourself (overwrites any previous — only one active at a time).",
		"The content will appear as a `<reminder>` tag after the specified number of rounds.",
		"Use it to track progress on multi-step tasks: what's done, what's next, what to watch out for.",
		"",
		"This tool is deterministic and always succeeds — do not wait for its result.",
	].join("\n"),
	parameters: zodToParameters(ReminderArgsSchema, reminderDescriptions),
};

export interface PendingReminder {
	content: string;
	roundsLeft: number;
	/** 模型设置时估算的原始轮数 */
	originalEstimate: number;
}

export function reminderTool(
	call: ReminderToolCall,
	reminders: PendingReminder[],
): ReminderToolResult {
	const estimate = call.args.estimate ?? 7;
	reminders.length = 0;
	reminders.push({
		content: call.args.content,
		roundsLeft: estimate,
		originalEstimate: estimate,
	});

	return {
		type: "tool_result",
		tool: "reminder" as const,
		call,
		acknowledged: true,
	};
}
