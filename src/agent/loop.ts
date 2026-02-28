/**
 * Agent Loop — 核心 agent 循环
 *
 * 接收 DomainMessage[] 历史，驱动 LLM + 工具调用循环，
 * 直到 agent 调用 submit 或达到终止条件。
 */

import { config } from "../config.ts";
import { toAPIMessages } from "../llm/adapter.ts";
import { chatCompletion } from "../llm/client.ts";
import type { PendingReminder } from "../tools/index.ts";
import {
	execTool,
	reminderTool,
	submitTool,
	TOOL_DEFINITIONS,
	writeTool,
} from "../tools/index.ts";
import type {
	AssistantToolCallMessage,
	DomainMessage,
	ToolCallRecord,
	ToolResult,
} from "../types/domain.ts";
import type { LLMToolCall } from "../types/llm.ts";

// ── 结果类型 ──

export interface AgentResult<T = unknown> {
	result: T;
	report: string | null;
	history: DomainMessage[];
}

export interface AgentOptions {
	/** 最大循环轮次 */
	maxIterations?: number;
	/** 结果校验函数，返回 null 表示通过，返回字符串表示拒绝原因 */
	validateResult?: (result: unknown) => string | null;
}

// ── Agent Loop ──

export async function agentLoop(
	history: DomainMessage[],
	options?: AgentOptions,
): Promise<AgentResult> {
	const maxIter = options?.maxIterations ?? config.agent.maxIterations;
	const messages: DomainMessage[] = [...history];
	const reminders: PendingReminder[] = [];
	let idleCount = 0;

	for (let iteration = 0; iteration < maxIter; iteration++) {
		// 注入到期的 reminders
		injectReminders(messages, reminders);

		// 转换为 API 格式并调用 LLM
		const apiMessages = toAPIMessages(messages);
		console.error(
			`  [agent] round ${iteration + 1}/${maxIter} (${apiMessages.length} msgs)`,
		);
		const response = await chatCompletion({
			messages: apiMessages,
			tools: TOOL_DEFINITIONS,
			tool_choice: "auto",
		});

		const choice = response.choices[0];
		if (!choice) throw new Error("LLM returned empty choices");

		const assistantMsg = choice.message;
		const hasToolCalls =
			assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0;

		// 无工具调用 — 纯文本回复
		if (!hasToolCalls) {
			const content = assistantMsg.content ?? "";
			console.error(
				`  [agent] text response (${content.length} chars), idle=${idleCount + 1}`,
			);
			const textMsg: DomainMessage = {
				type: "assistant_text",
				content,
			};
			messages.push(textMsg);

			// 空转检测
			idleCount++;
			if (idleCount >= config.agent.maxIdleRounds) {
				return {
					result: content,
					report: "Agent terminated: max idle rounds exceeded (no tool calls)",
					history: messages,
				};
			}
			continue;
		}

		// 有工具调用
		idleCount = 0;

		// 解析工具调用记录
		const toolCalls = parseToolCalls(assistantMsg.tool_calls ?? []);
		const toolCallMsg: AssistantToolCallMessage = {
			type: "assistant_tool_call",
			content: assistantMsg.content,
			toolCalls,
		};
		messages.push(toolCallMsg);

		// 执行每个工具
		for (const tc of toolCalls) {
			console.error(
				`  [agent] tool: ${tc.tool}${tc.tool === "exec" ? ` → ${(tc.args as { command?: string }).command?.slice(0, 80)}` : ""}`,
			);
			const result = await executeTool(tc, reminders);
			messages.push(result);

			// 如果是 submit，校验并返回
			if (result.tool === "submit") {
				const validation = options?.validateResult?.(result.result);
				if (validation) {
					// 校验失败，注入拒绝消息，继续循环
					console.error(`  [agent] submit rejected: ${validation}`);
					messages.push({
						type: "user_text",
						content: `Your submission was rejected: ${validation}\nPlease fix and submit again.`,
					});
					break;
				}
				console.error("  [agent] submit accepted ✓");
				return {
					result: result.result,
					report: result.report,
					history: messages,
				};
			}
		}
	}

	// 超过最大轮次
	return {
		result: null,
		report: `Agent terminated: max iterations (${maxIter}) exceeded`,
		history: messages,
	};
}

// ── 辅助函数 ──

function parseToolCalls(raw: LLMToolCall[]): ToolCallRecord[] {
	return raw.map((tc) => {
		let args: Record<string, unknown>;
		try {
			const parsed =
				typeof tc.function.arguments === "string"
					? JSON.parse(tc.function.arguments)
					: tc.function.arguments;
			args = parsed as Record<string, unknown>;
		} catch {
			args = { _parseError: true, _raw: tc.function.arguments };
		}
		return {
			id: tc.id,
			tool: tc.function.name,
			args,
		};
	});
}

async function executeTool(
	tc: ToolCallRecord,
	reminders: PendingReminder[],
): Promise<ToolResult> {
	const a = tc.args as unknown;
	switch (tc.tool) {
		case "exec":
			return execTool(tc.id, a as Parameters<typeof execTool>[1]);
		case "write":
			return writeTool(tc.id, a as Parameters<typeof writeTool>[1]);
		case "reminder":
			return reminderTool(
				tc.id,
				a as Parameters<typeof reminderTool>[1],
				reminders,
			);
		case "submit":
			return submitTool(tc.id, a as Parameters<typeof submitTool>[1]);
		default:
			return {
				type: "tool_result",
				callId: tc.id,
				tool: "exec",
				command: "",
				cwd: "",
				exitCode: 1,
				stdout: "",
				stderr: `Unknown tool: ${tc.tool}`,
				durationMs: 0,
			};
	}
}

function injectReminders(
	messages: DomainMessage[],
	reminders: PendingReminder[],
): void {
	const due: PendingReminder[] = [];
	const remaining: PendingReminder[] = [];

	for (const r of reminders) {
		r.roundsLeft--;
		if (r.roundsLeft <= 0) {
			due.push(r);
		} else {
			remaining.push(r);
		}
	}

	// 替换原数组内容
	reminders.length = 0;
	reminders.push(...remaining);

	// 注入到期提醒
	for (const r of due) {
		messages.push({
			type: "user_text",
			content: `⏰ REMINDER: ${r.content}`,
		});
	}
}
