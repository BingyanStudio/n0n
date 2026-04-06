/**
 * reminder 工具 — 为 agent 自己设置延迟提醒
 *
 * 设计意图：模型在长线任务中容易忘记全局目标和进展。
 * 对比 todo list 方案，reminder 将规划、反思、调整融入工作流程：
 * - 模型自定义每步所需轮数（承诺），到期时触发强制反思
 * - 承诺违背时必须输出 <reflection> 分析原因，形成负反馈闭环
 * - OKR 结构化内容（Objective + Key Results + Current）强制清晰规划
 *
 * 核心机制：承诺-反思循环
 * - delay 是一个承诺：agent 承诺在 N 轮内完成当前阶段
 * - 到期时系统注入 <reminder> 标签内容，触发强制反思
 * - agent 必须用 <reflection> 标签输出反思结论
 */

import type {
	ReminderToolCall,
	ReminderToolResult,
	ToolDefinition,
} from "@n0n/types";

export { ReminderArgsSchema } from "@n0n/types";

export const REMINDER_TOOL_DEFINITION: ToolDefinition = {
	name: "reminder",
	description: [
		"Set a memo/reminder for yourself (overwrites any previous — only one active at a time).",
		"The content will appear as `<reminder>` tag in a future user message after the specified delay (rounds).",
		"",
		"**delay is a commitment** — you are promising to complete the **next step** within N rounds.",
		"If the reminder fires (delay expires), it means your commitment was not met.",
		"You MUST then output a `<reflection>` block analyzing why, before setting the next reminder.",
		"",
		"Usage: After breaking down the task, create a reminder summarizing:",
		"  1. The overall Objective",
		"  2. Key Results (checklist of what remains)",
		"  3. Current progress and next step",
		"  4. delay = rounds to complete the next step (NOT the entire task)",
		"",
		"Example:",
		"  O: Refactor submit schema",
		"  KR: 1.✅ Read code  2.[ ] Update schema  3.[ ] Update references  4.[ ] Test",
		"  Current: KR1 done, next: KR2, ~2 rounds → delay: 2",
		"",
		"After completing each step, set a new reminder for the next step.",
		"Prefer conservative estimates — overdelivering early is better than breaking a commitment.",
	].join("\n"),
	parameters: {
		type: "object",
		properties: {
			content: {
				type: "string",
				description:
					"Reminder content: include OKR summary, progress status, and next step",
			},
			estimate: {
				type: "number",
				description:
					"Number of rounds to complete the **next step** — not the entire task (default: 7). This is a promise, not a guess.",
			},
		},
		required: ["content"],
		additionalProperties: false,
	},
};

export interface PendingReminder {
	content: string;
	roundsLeft: number;
	/** 模型设置时承诺的原始轮数 */
	originalEstimate: number;
}

export function reminderTool(
	call: ReminderToolCall,
	reminders: PendingReminder[],
): ReminderToolResult {
	const delay = call.args.estimate ?? 7;
	reminders.length = 0;
	reminders.push({
		content: call.args.content,
		roundsLeft: delay,
		originalEstimate: delay,
	});

	return {
		type: "tool_result",
		tool: "reminder" as const,
		call,
		acknowledged: true,
	};
}
