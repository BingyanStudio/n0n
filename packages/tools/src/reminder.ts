/**
 * reminder 工具 — agent 的番茄钟 / 效率追踪器
 *
 * 设计意图：让 agent 像人类使用番茄钟一样，为每个阶段设定时间预算。
 * 通过诚实估算 → 执行 → 到期反思的循环，持续校准对工作量的判断力。
 *
 * 核心机制：估算-反思循环
 * - estimate 是 agent 对下一步所需轮次的诚实预测（1 轮 = 1 次 assistant 响应，可含多个并行工具调用）
 * - 到期时系统注入 <reminder> 标签内容，触发反思
 * - 反思关注：是客观因素（意外复杂度）还是效率问题（工具调用未并行）？
 * - 无论超时与否，反思帮助 agent 更好地理解任务本身
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
		"The content will appear as a `<reminder>` tag in a future message after the specified number of rounds.",
		"",
		"**1 round = 1 assistant response.** A single response can contain many parallel tool calls,",
		"so reading 5 files in one response is 1 round, not 5. Batching independent calls saves rounds.",
		"",
		"**estimate is your honest prediction** — how many rounds will the next step realistically take?",
		"The goal is accuracy, not speed. Underestimating wastes the mechanism;",
		"overestimating is fine (finishing early is a good sign).",
		"",
		"When the reminder fires, reflect on why it took longer or shorter than expected:",
		"- Objective factors (unexpected complexity, missing information)?",
		"- Efficiency opportunities (could you have batched more tool calls into fewer rounds)?",
		"Either way, reflection helps you understand the task itself better. Recalibrate and continue.",
		"",
		"Usage: After breaking down the task, create a reminder summarizing:",
		"  1. The overall Objective",
		"  2. Key Results (checklist of what remains)",
		"  3. Current progress and next step",
		"  4. estimate = rounds for the next step (NOT the entire task)",
		"",
		"Example — small step:",
		"  O: Fix login bug",
		"  KR: 1.[ ] Read auth files  2.[ ] Identify bug  3.[ ] Fix  4.[ ] Test",
		"  Current: starting KR1, need to read 3 files (1 round, parallel) → estimate: 1",
		"",
		"Example — complex step:",
		"  O: Refactor database layer",
		"  KR: 1.✅ Read code  2.[ ] Redesign schema  3.[ ] Update 6 files  4.[ ] Test",
		"  Current: KR2, need to analyze dependencies across 4 modules,",
		"    draft new schema, validate constraints.",
		"    ~3 rounds of investigation + 1 round of design → estimate: 5",
		"",
		"After completing each step, set a new reminder for the next step.",
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
					"Estimated rounds to complete the next step — not the entire task (default: 7). Be honest: 1 round if trivial, 5+ if complex. Accuracy matters more than speed.",
			},
			is_completed_and_i_will_immediately_call_the_next_tool: {
				type: "boolean",
				description: "Always true. This tool returns no useful result — do not wait, immediately make your next tool call.",
			},
		},
		required: ["content", "is_completed_and_i_will_immediately_call_the_next_tool"],
		additionalProperties: false,
	},
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
