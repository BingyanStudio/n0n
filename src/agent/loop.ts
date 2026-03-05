/**
 * Agent Loop — 核心 agent 循环
 *
 * 接收 DomainMessage[] 历史，驱动 LLM + 工具调用循环，
 * 直到 agent 调用 submit 或达到终止条件。
 */

import type { ZodType } from "zod";
import { toJSONSchema } from "zod";
import { config } from "../config.ts";
import { toAPIMessages } from "../llm/adapter.ts";
import { chatCompletionStream, StreamAccumulator } from "../llm/stream.ts";
import type { PendingReminder } from "../tools/index.ts";
import { makeToolDefinitions } from "../tools/index.ts";
import type {
	AssistantToolCallMessage,
	DomainMessage,
	ToolResult,
} from "../types/domain.ts";
import type { Renderer } from "../ui/renderer.ts";
import { PlainRenderer } from "../ui/renderer.ts";
import { executeToolStream, isValidToolCall, parseToolCalls } from "./tool.ts";

// ── 结果类型 ──

export interface AgentResult<T = unknown> {
	result: T | null;
	report: string | null;
	history: DomainMessage[];
}

export interface AgentOptions<T = unknown> {
	/** 最大循环轮次 */
	maxIterations?: number;
	/** Zod schema 校验 submit 结果，默认视为 string */
	schema?: ZodType<T>;
	/** 渲染器，默认 PlainRenderer（向后兼容） */
	renderer?: Renderer;
	/** Interactive confirmation callback for blocked commands */
	confirmFn?: (question: string) => Promise<string>;
	/** Abort signal for interruption */
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

		// 注入到期的 reminders
		injectReminders(messages, reminders);

		// 转换为 API 格式并调用 LLM（流式）
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

		// 无工具调用 — 纯文本回复
		if (!hasToolCalls) {
			const content = assistantMsg.content ?? "";
			if (!acc.reasoning && !content) {
				// 流式已经输出过内容，不重复
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

			// 空转检测
			if (idleCount >= config.agent.maxIdleRounds) {
				renderer.agentTerminated("max idle rounds exceeded (no tool calls)");
				return {
					result: content as T,
					report: "Agent terminated: max idle rounds exceeded (no tool calls)",
					history: messages,
				};
			}

			// 注入空转提示，打断连续 assistant 序列并引导调用工具
			messages.push({
				type: "idle_nudge",
				idleCount,
				maxIdleRounds: config.agent.maxIdleRounds,
			});
			continue;
		}

		// 有工具调用
		idleCount = 0;

		// 解析工具调用记录，过滤掉畸形的 tool call（空 name 或 args 解析失败）
		const toolCalls = parseToolCalls(assistantMsg.tool_calls ?? []).filter(
			isValidToolCall,
		);

		// 过滤后无有效 tool call → 视为纯文本回复
		if (toolCalls.length === 0) {
			const content = assistantMsg.content ?? "";
			idleCount++;
			messages.push({ type: "assistant_text", content });
			if (idleCount >= config.agent.maxIdleRounds) {
				renderer.agentTerminated("max idle rounds exceeded (no tool calls)");
				return {
					result: content as T,
					report: "Agent terminated: max idle rounds exceeded (no tool calls)",
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

		// 执行每个工具（流式）
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
				// 不应发生：generator 必须 yield 一个 ToolResult
				throw new Error(`Tool ${tc.tool} stream ended without a result`);
			}
			renderer.toolCallEnd(result);
			messages.push(result);

			// 如果是 submit，校验并返回
			if (result.tool === "submit") {
				const validation = validateSubmit(result.result, options?.schema);
				if (validation.ok) {
					renderer.submitAccepted();
					return {
						result: validation.value as T,
						report: result.report,
						history: messages,
					};
				}
				// 校验失败
				submitRetries++;
				if (submitRetries >= MAX_SUBMIT_RETRIES) {
					renderer.submitRejected(
						submitRetries,
						MAX_SUBMIT_RETRIES,
						`giving up after ${submitRetries} attempts`,
					);
					return {
						result: result.result as T,
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
					type: "user_text",
					content: `Your submission was rejected: ${validation.error}\nPlease fix the format and submit again. (attempt ${submitRetries}/${MAX_SUBMIT_RETRIES})`,
				});
				break;
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

function validateSubmit(
	raw: unknown,
	schema?: ZodType,
): { ok: true; value: unknown } | { ok: false; error: string } {
	// 无 schema → 默认当 string 处理
	if (!schema) {
		return {
			ok: true,
			value: typeof raw === "string" ? raw : JSON.stringify(raw),
		};
	}

	// 如果 raw 是 string，尝试解析为 JSON 再校验
	let parsed: unknown = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch {
			// 不是 JSON，直接用原始字符串校验
		}
	}

	const result = schema.safeParse(parsed);
	if (result.success) {
		return { ok: true, value: result.data };
	}

	const issues = result.error.issues
		.map((i) => `  ${String(i.path.join("."))}: ${i.message}`)
		.join("\n");

	// 校验失败时返回完整的 JSON Schema，而不仅仅是错误片段
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

	// 替换原数组内容
	reminders.length = 0;
	reminders.push(...remaining);

	// 注入到期提醒
	for (const r of due) {
		messages.push({
			type: "user_text",
			content: `⏰ REMINDER: ${r.content}\n\n⚠️ You MUST set a new reminder (with updated progress) in your next tool call response.`,
		});
	}
}
