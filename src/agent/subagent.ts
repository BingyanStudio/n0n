/**
 * subagent — 核心调用接口
 *
 * 给定对话历史，启动一个 agent loop 完成任务并返回结果。
 * 这是 workflow 代码中最常用的原语。
 */

import type { DomainMessage } from "../types/domain.ts";
import type { AgentResult } from "./loop.ts";
import { agentLoop } from "./loop.ts";

export interface SubagentOptions {
	/** 结果校验函数 */
	validateResult?: (result: unknown) => string | null;
	/** 最大循环轮次 */
	maxIterations?: number;
}

/**
 * 启动一个 subagent，给定系统提示和用户任务
 */
export async function subagent(
	task: string,
	options?: SubagentOptions & { systemPrompt?: string },
): Promise<AgentResult> {
	const history: DomainMessage[] = [
		{
			type: "system",
			content:
				options?.systemPrompt ??
				[
					"You are a capable AI agent. You can execute commands, read/write files, and solve problems step by step.",
					"Use the `exec` tool to run commands and read files (cat, grep, ls, etc.).",
					"Use the `write` tool to create or edit files.",
					"Use the `reminder` tool to set reminders for yourself during long tasks.",
					"When you have completed the task, use `submit` to deliver your result.",
					"Think carefully, work incrementally, and verify your work before submitting.",
				].join("\n"),
		},
		{
			type: "user_text",
			content: task,
		},
	];

	return agentLoop(history, {
		maxIterations: options?.maxIterations,
		validateResult: options?.validateResult,
	});
}

/**
 * 使用已有的对话历史继续 agent loop
 */
export async function subagentWithHistory(
	history: DomainMessage[],
	options?: SubagentOptions,
): Promise<AgentResult> {
	return agentLoop(history, {
		maxIterations: options?.maxIterations,
		validateResult: options?.validateResult,
	});
}
