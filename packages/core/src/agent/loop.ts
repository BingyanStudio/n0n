/**
 * Agent Loop — 核心 agent 循环
 *
 * 接收 DomainMessage[] 历史，驱动 LLM + 工具调用循环，
 * 直到 agent 调用 submit 或达到终止条件。
 */

import {
	chatCompletionStream,
	StreamAccumulator,
	toAPIMessages,
} from "@n0n/llm";
import type { PendingReminder } from "@n0n/tools";
import { makeToolDefinitions } from "@n0n/tools";
import type {
	AssistantToolCallMessage,
	DomainMessage,
	Renderer,
	ToolResult,
} from "@n0n/types";
import type { ZodType } from "zod";
import { toJSONSchema } from "zod";
import { config } from "../config.ts";
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
}

const MAX_SUBMIT_RETRIES = 4;

// ── Agent Loop ──

export async function agentLoop<T = unknown>(
	history: DomainMessage[],
	options?: AgentOptions<T>,
): Promise<AgentResult<T>> {
	const maxIter = options?.maxIterations ?? config.agent.maxIterations;
	const renderer = options?.renderer ?? new PlainRenderer();
	const toolDefs = makeToolDefinitions(options?.schema);
	const messages: DomainMessage[] = [...history];
	const reminders: PendingReminder[] = [];
	let idleCount = 0;
	let submitRetries = 0;

	for (let iteration = 0; iteration < maxIter; iteration++) {
		if (options?.signal?.aborted) {
			return {
				result: null,
				report: "Agent terminated: aborted",
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
				tools: toolDefs,
				tool_choice: "auto",
			},
			{ signal: options?.signal },
		)) {
			if (options?.signal?.aborted) {
				return {
					result: null,
					report: "Agent terminated: aborted",
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

			if (idleCount >= config.agent.maxIdleRounds) {
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
				maxIdleRounds: config.agent.maxIdleRounds,
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
			if (idleCount >= config.agent.maxIdleRounds) {
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
				maxIdleRounds: config.agent.maxIdleRounds,
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
				return {
					result: null,
					report: "Agent terminated: aborted",
					history: messages,
				};
			}
			renderer.toolCallStart(tc);
			let result: ToolResult | undefined;
			for await (const event of executeToolStream(
				tc,
				reminders,
				options?.confirmFn,
			)) {
				if (event.type === "tool_output_chunk") {
					renderer.toolResultChunk(event.tool, event.chunk);
				} else {
					result = event;
				}
			}
			if (!result) {
				throw new Error(`Tool ${tc.tool} stream ended without a result`);
			}
			renderer.toolCallEnd(result);
			messages.push(result);

			if (result.tool === "submit") {
				const validation = validateSubmit(result.result, options?.schema);
				if (validation.ok) {
					renderer.submitAccepted();
					return {
						result: validation.value,
						report: result.report,
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

function validateSubmit<T>(
	raw: unknown,
	schema?: ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
	if (!schema) {
		const value = (typeof raw === "string" ? raw : JSON.stringify(raw)) as T;
		return { ok: true, value };
	}

	let parsed: unknown = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch {
			// not JSON, use raw string
		}
	}

	const result = schema.safeParse(parsed);
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
