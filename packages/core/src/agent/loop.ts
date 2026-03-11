/**
 * Agent Loop — 核心 agent 循环
 *
 * 接收 DomainMessage[] 历史，驱动 LLM + 工具调用循环，
 * 直到 agent 调用 submit 或达到终止条件。
 */

import {
	chatCompletionStream,
	getLLMConfig,
	StreamAccumulator,
	toAPIMessages,
} from "@n0n/llm";
import type { PendingReminder } from "@n0n/tools";
import { makeToolkit } from "@n0n/tools";
import type {
	AssistantToolCallMessage,
	DomainMessage,
	Renderer,
	ToolResult,
} from "@n0n/types";
import type { ZodType } from "zod";
import { toJSONSchema } from "zod";
import { getRuntime } from "../config.ts";
import { PlainRenderer } from "../ui/renderer.ts";
import { executeToolStream, isValidToolCall, parseToolCalls } from "./tool.ts";

// ── 结果类型 ──

export interface AgentResult<T = unknown> {
	result: T | null;
	report: string | null;
	history: DomainMessage[];
}

export interface AgentOptions<T = unknown> {
	maxIterations?: number;
	schema?: ZodType<T>;
	renderer?: Renderer;
	confirmFn?: (question: string) => Promise<string>;
	signal?: AbortSignal;
	/** 工具执行的工作区覆盖（用于 per-session 隔离，如 Feishu 多用户场景） */
	toolsWorkspace?: { workspace: string; tempDir: string };
}

const MAX_SUBMIT_RETRIES = 4;

// ── Agent Loop ──

export async function agentLoop<T = unknown>(
	history: DomainMessage[],
	options?: AgentOptions<T>,
): Promise<AgentResult<T>> {
	const maxIter = options?.maxIterations ?? getRuntime().agent.maxIterations;
	const renderer = options?.renderer ?? new PlainRenderer();
	const toolkit = await makeToolkit(
		options?.schema,
		options?.toolsWorkspace,
		getLLMConfig().model,
	);
	const messages: DomainMessage[] = [...history];
	const reminders: PendingReminder[] = [];
	let idleCount = 0;
	let submitRetries = 0;

	for (let iteration = 0; iteration < maxIter; iteration++) {
		if (options?.signal?.aborted) {
			renderer.aborted();
			return {
				result: null,
				report: null,
				history: messages,
			};
		}

		injectReminders(messages, reminders);

		const apiMessages = toAPIMessages(messages);
		renderer.roundStart(iteration + 1, maxIter, apiMessages.length);

		const acc = new StreamAccumulator();
		for await (const event of chatCompletionStream(
			{
				messages: apiMessages,
				tools: toolkit.definitions,
				tool_choice: "auto",
			},
			{ signal: options?.signal },
		)) {
			if (options?.signal?.aborted) {
				renderer.aborted();
				return {
					result: null,
					report: null,
					history: messages,
				};
			}
			acc.push(event);
			switch (event.type) {
				case "thinking":
					renderer.thinkingToken(event.text);
					break;
				case "content":
					renderer.contentToken(event.text);
					break;
				case "tool_call_delta":
					renderer.toolCallArgChunk(event.index, event.name, event.arguments);
					break;
			}
		}
		renderer.contentEnd();

		// stream 正常结束后再次检查 abort（chatCompletionStream abort 时直接 return，
		// 不抛错，for-await 会正常结束，需在此拦截避免向 history 追加不完整消息）
		if (options?.signal?.aborted) {
			renderer.aborted();
			return {
				result: null,
				report: null,
				history: messages,
			};
		}

		const assistantMsg = acc.toMessage();
		const hasToolCalls =
			assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0;

		if (!hasToolCalls) {
			const content = assistantMsg.content ?? "";
			if (!acc.reasoning && !content) {
				idleCount++;
				renderer.textResponse(content, idleCount);
			} else {
				idleCount++;
			}
			const textMsg: DomainMessage = {
				type: "assistant_text",
				content,
			};
			messages.push(textMsg);

			if (idleCount >= getRuntime().agent.maxIdleRounds) {
				renderer.agentTerminated("max idle rounds exceeded (no tool calls)");
				return {
					result: null,
					report: `Agent terminated: max idle rounds exceeded (no tool calls). Last content: ${content.slice(0, 200)}`,
					history: messages,
				};
			}

			messages.push({
				type: "idle_nudge",
				idleCount,
				maxIdleRounds: getRuntime().agent.maxIdleRounds,
			});
			continue;
		}

		idleCount = 0;

		const toolCalls = parseToolCalls(assistantMsg.tool_calls ?? []).filter(
			isValidToolCall,
		);

		if (toolCalls.length === 0) {
			const content = assistantMsg.content ?? "";
			idleCount++;
			messages.push({ type: "assistant_text", content });
			if (idleCount >= getRuntime().agent.maxIdleRounds) {
				renderer.agentTerminated("max idle rounds exceeded (no tool calls)");
				return {
					result: null,
					report: `Agent terminated: max idle rounds exceeded (no tool calls). Last content: ${content.slice(0, 200)}`,
					history: messages,
				};
			}
			messages.push({
				type: "idle_nudge",
				idleCount,
				maxIdleRounds: getRuntime().agent.maxIdleRounds,
			});
			continue;
		}

		const toolCallMsg: AssistantToolCallMessage = {
			type: "assistant_tool_call",
			content: assistantMsg.content,
			toolCalls,
		};
		messages.push(toolCallMsg);

		for (const tc of toolCalls) {
			if (options?.signal?.aborted) {
				renderer.aborted();
				return {
					result: null,
					report: null,
					history: messages,
				};
			}
			renderer.toolCallStart(tc);
			let result: ToolResult | undefined;
			let argError = false;
			for await (const event of executeToolStream(
				tc,
				reminders,
				options?.confirmFn,
				toolkit.getEntry,
			)) {
				if (event.type === "tool_output_chunk") {
					renderer.toolResultChunk(event.tool, event.chunk);
				} else if (event.type === "tool_arg_error") {
					messages.push(event);
					argError = true;
				} else {
					result = event;
				}
			}
			if (argError) continue;
			if (!result) {
				throw new Error(`Tool ${tc.tool} stream ended without a result`);
			}
			renderer.toolCallEnd(result);
			messages.push(result);

			if (result.tool === "submit") {
				const validation = validateSubmit(
					result.cleanedResult,
					options?.schema,
				);
				if (validation.ok) {
					renderer.submitAccepted();
					return {
						result: validation.value,
						report: result.call.args.report ?? null,
						history: messages,
					};
				}
				submitRetries++;
				if (submitRetries >= MAX_SUBMIT_RETRIES) {
					renderer.submitRejected(
						submitRetries,
						MAX_SUBMIT_RETRIES,
						`giving up after ${submitRetries} attempts`,
					);
					return {
						result: null,
						report: `Submit validation failed after ${MAX_SUBMIT_RETRIES} retries: ${validation.error}`,
						history: messages,
					};
				}
				renderer.submitRejected(
					submitRetries,
					MAX_SUBMIT_RETRIES,
					validation.error,
				);
				messages.push({
					type: "submit:rejected",
					error: validation.error,
					attempt: submitRetries,
					maxAttempts: MAX_SUBMIT_RETRIES,
				});
				break;
			}
		}
	}

	return {
		result: null,
		report: `Agent terminated: max iterations (${maxIter}) exceeded`,
		history: messages,
	};
}

// ── 辅助函数 ──

/**
 * 校验 submit 结果是否符合 schema。
 *
 * LLM tool call arguments 始终是 JSON 对象（由 API 规范保证），
 * 经 parseToolCalls → extractSubmitResult 后 raw 已经是正确的 JS 对象，
 * 无需再做 string → JSON.parse 转换。
 *
 * - 无 schema 时：直接通过，T 默认为 unknown。
 * - 有 schema 时：用 Zod safeParse 校验，失败则返回详细错误。
 */
function validateSubmit<T = unknown>(
	raw: unknown,
	schema?: ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
	if (!schema) {
		return { ok: true, value: raw as T };
	}

	const result = schema.safeParse(raw);
	if (result.success) {
		return { ok: true, value: result.data };
	}

	const issues = result.error.issues
		.map((i) => `  ${String(i.path.join("."))}: ${i.message}`)
		.join("\n");

	let fullSchema: string;
	try {
		fullSchema = JSON.stringify(toJSONSchema(schema), null, 2);
	} catch {
		fullSchema = "(schema serialization failed)";
	}

	return {
		ok: false,
		error: `Result does not match expected schema:\n${issues}\n\nFull expected schema:\n${fullSchema}`,
	};
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

	reminders.length = 0;
	reminders.push(...remaining);

	for (const r of due) {
		messages.push({
			type: "reminder:due",
			content: r.content,
		});
	}
}
