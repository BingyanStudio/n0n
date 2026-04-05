/**
 * Agent Loop — 核心 agent 循环
 *
 * 接收 DomainMessage[] 历史，驱动 LLM + 工具调用循环，
 * 直到 agent 调用 submit 或达到终止条件。
 *
 * 流水线执行：参数就绪即入队调度、贪婪并行执行、顺序渲染。
 * 调度模型见 scheduler.ts，渲染缓冲见 render-buffer.ts。
 *
 * TODO 当前 loop.ts 同时承担了 streaming 事件分发、截断恢复、调度编排、渲染驱动等职责。
 * 后续应考虑将 streaming 解析等拆分为独立模块，降低单文件复杂度。
 */

import type { PendingReminder, ToolsConfig } from "@n0n/tools";
import { makeToolkit } from "@n0n/tools";
import type {
	AssistantToolCallMessage,
	DomainMessage,
	Renderer,
	ToolCallRecord,
	TokenUsage,
	TruncatedToolCallInfo,
} from "@n0n/types";
import { FinishReason, StreamAccumulator } from "@n0n/types";
import type { ZodType } from "zod";
import { toJSONSchema } from "zod";
import { getRuntime } from "../runtime.ts";
import { PlainRenderer } from "../ui/renderer.ts";
import { RenderBuffer } from "./render-buffer.ts";
import { ExecutionScheduler } from "./scheduler.ts";
import { executeToolStream, isValidToolCall, parseToolCalls } from "./tool.ts";
import { analyzeTruncatedCalls, type PartialToolCall } from "./truncation.ts";

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
	toolsWorkspace?: { workspace: string; tempDir: string };
}

const MAX_SUBMIT_RETRIES = 4;

// ── Streaming 阶段状态 ──

/** streaming 阶段的当前子状态 — 替代多个独立 flag */
type StreamPhase = "idle" | "thinking" | "content" | "tool_args";

/** 单轮 streaming 的状态 */
interface RoundStreamState {
	phase: StreamPhase;
	/** 中断原因（null = 正常结束） */
	interrupt: "length" | "error" | "aborted" | null;
	/** 已见到的工具调用 index */
	seenIndices: Set<number>;
	/** 已完整解析的工具调用 index */
	completedIndices: Set<number>;
	/** 已完整解析的工具（index → ToolCallRecord） */
	completedTools: Map<number, ToolCallRecord>;
}

function createRoundState(): RoundStreamState {
	return {
		phase: "idle",
		interrupt: null,
		seenIndices: new Set(),
		completedIndices: new Set(),
		completedTools: new Map(),
	};
}

// ── Agent Loop ──

export async function agentLoop<T = unknown>(
	history: DomainMessage[],
	options?: AgentOptions<T>,
): Promise<AgentResult<T>> {
	const maxIter = options?.maxIterations ?? getRuntime().agent.maxIterations;
	const renderer = options?.renderer ?? new PlainRenderer();
	const runtime = getRuntime();
	const client = runtime.client;
	const modelId = client.modelId;
	const toolsConfig: ToolsConfig = {
		security: runtime.security,
		agent: runtime.agent,
		editorClient: runtime.editorClient,
		...(options?.toolsWorkspace ?? {
			workspace: process.cwd(),
			tempDir: ".temp",
		}),
	};
	const toolkit = await makeToolkit(options?.schema, toolsConfig, modelId);
	const messages: DomainMessage[] = [...history];
	const reminders: PendingReminder[] = [];
	let idleCount = 0;
	let submitRetries = 0;
	let lastUsage: TokenUsage | null = null;

	for (let iteration = 0; iteration < maxIter; iteration++) {
		if (options?.signal?.aborted) {
			renderer.aborted();
			return { result: null, report: null, history: messages };
		}

		injectReminders(messages, reminders);
		renderer.roundStart(iteration + 1, maxIter, messages.length, lastUsage);

		const acc = new StreamAccumulator();
		const state = createRoundState();

		// ── 流水线调度器 ──
		const scheduler = new ExecutionScheduler((tc) =>
			executeToolStream(tc, reminders, options?.confirmFn, toolkit.getEntry),
		);
		const renderBuffer = new RenderBuffer();
		scheduler.attachRenderBuffer(renderBuffer);
		const runPromise = scheduler.run(options?.signal);

		// ── Streaming 循环 ──
		for await (const event of client.stream(
			{ messages, tools: toolkit.tools, toolChoice: "auto" },
			options?.signal,
		)) {
			if (options?.signal?.aborted) {
				state.interrupt = "aborted";
				break;
			}
			acc.push(event);
			switch (event.type) {
				case "thinking":
					if (state.phase !== "thinking") state.phase = "thinking";
					renderer.thinkingChunk(event.text);
					break;
				case "content":
					if (state.phase === "thinking") {
						renderer.thinkingEnd();
					}
					state.phase = "content";
					renderer.contentChunk(event.text);
					break;
				case "tool_call_delta": {
					if (state.phase === "thinking") renderer.thinkingEnd();
					if (state.phase === "content") renderer.contentEnd();
					state.phase = "tool_args";

					if (!state.seenIndices.has(event.index)) {
						state.seenIndices.add(event.index);
						renderer.toolCallArgStart(event.index, event.name ?? "?");
					}
					renderer.toolCallArgChunk(event.index, event.arguments);

					// JSON 完整性检测 → argEnd + 入队调度器
					if (!state.completedIndices.has(event.index)) {
						const tcAcc = acc.toolCalls.get(event.index);
						if (tcAcc) {
							try {
								JSON.parse(tcAcc.input);
								state.completedIndices.add(event.index);
								const parsed = parseToolCalls([tcAcc]);
								const parsedTc = parsed[0];
								if (parsedTc && isValidToolCall(parsedTc)) {
									renderer.toolCallArgEnd(event.index, parsedTc);
									state.completedTools.set(event.index, parsedTc);
									scheduler.enqueue(parsedTc);
								}
							} catch {
								// JSON 尚未完整
							}
						}
					}
					break;
				}
				case "error":
					if (state.phase === "thinking") renderer.thinkingEnd();
					state.interrupt = "error";
					break;
			}
		}
		// ── Streaming 结束，关闭 renderer 状态 ──
		if (state.phase === "content") renderer.contentEnd();
		if (state.phase === "thinking") renderer.thinkingEnd();
		renderer.streamEnd();

		lastUsage = acc.usage;

		// ── 中断/过滤快速路径 ──
		if (state.interrupt === "aborted") {
			// abort 也走截断处理（已入队的工具照常执行）
			// 但如果没有任何工具入队，直接返回
			if (state.completedTools.size === 0 && state.seenIndices.size === 0) {
				scheduler.seal();
				renderer.aborted();
				return { result: null, report: null, history: messages };
			}
		}

		if (state.interrupt === "error" && state.completedTools.size === 0) {
			scheduler.seal();
			renderer.agentTerminated("LLM error");
			return { result: null, report: "LLM stream error", history: messages };
		}

		if (acc.finishReason === FinishReason.CONTENT_FILTER) {
			scheduler.seal();
			messages.push({
				type: "assistant_text",
				content: acc.content || "",
				reasoning: acc.reasoning || undefined,
				reasoningSignature: acc.reasoningSignature || undefined,
			});
			renderer.agentTerminated("Content was filtered by the model provider.");
			return { result: null, report: "Agent terminated: content filter triggered", history: messages };
		}

		if (acc.finishReason === FinishReason.LENGTH) {
			state.interrupt = "length";
		}

		// ── 构建 assistant 消息 ──
		const assistantMsg = acc.toMessage();
		const allToolCalls = parseToolCalls(assistantMsg.toolCalls).filter(isValidToolCall);
		const hasIncomplete = state.seenIndices.size > state.completedIndices.size;
		const hasToolCalls = allToolCalls.length > 0 || hasIncomplete;

		// ── 无工具调用分支 ──
		if (!hasToolCalls && !state.interrupt) {
			scheduler.seal();
			const content = assistantMsg.content ?? "";
			idleCount++;
			if (!acc.reasoning && !content) {
				renderer.textResponse(content, idleCount);
			}
			messages.push({
				type: "assistant_text",
				content,
				reasoning: assistantMsg.reasoningText,
				reasoningSignature: assistantMsg.reasoningSignature,
			});
			if (idleCount >= getRuntime().agent.maxIdleRounds) {
				renderer.agentTerminated("max idle rounds exceeded (no tool calls)");
				return {
					result: null,
					report: `Agent terminated: max idle rounds exceeded. Last content: ${content.slice(0, 200)}`,
					history: messages,
				};
			}
			messages.push({ type: "idle_nudge", idleCount, maxIdleRounds: getRuntime().agent.maxIdleRounds });
			continue;
		}

		if (!hasToolCalls && state.interrupt === "length") {
			scheduler.seal();
			messages.push({
				type: "assistant_text",
				content: acc.content || "",
				reasoning: acc.reasoning || undefined,
				reasoningSignature: acc.reasoningSignature || undefined,
			});
			messages.push({
				type: "user_text",
				content: "Your previous response was truncated due to max_tokens limit. Please retry with a shorter response, or break the task into smaller steps.",
			});
			continue;
		}

		idleCount = 0;

		// ── 截断工具处理（委托 truncation 模块） ──
		const partials: PartialToolCall[] = [];
		for (const idx of state.seenIndices) {
			if (state.completedIndices.has(idx)) continue;
			const tcAcc = acc.toolCalls.get(idx);
			if (!tcAcc) continue;
			partials.push({
				index: idx,
				toolCallId: tcAcc.toolCallId,
				toolName: tcAcc.toolName,
				partialInput: tcAcc.input,
			});
		}

		const truncation = analyzeTruncatedCalls(
			partials,
			state.interrupt ?? "length",
		);

		// 将恢复的工具（截断 write 补全）入队执行
		const toolCallsForMsg = [...allToolCalls];
		for (const tc of truncation.recoveredTools) {
			toolCallsForMsg.push(tc);
			scheduler.enqueue(tc);
		}

		// 标记 producer 结束
		scheduler.seal();

		if (toolCallsForMsg.length === 0 && truncation.truncatedCalls.length === 0) {
			continue;
		}

		// ── 构建 assistant_tool_call 消息 ──
		const toolCallMsg: AssistantToolCallMessage = {
			type: "assistant_tool_call",
			content: assistantMsg.content,
			reasoning: assistantMsg.reasoningText,
			reasoningSignature: assistantMsg.reasoningSignature,
			toolCalls: toolCallsForMsg,
			truncatedCalls: truncation.truncatedCalls.length > 0 ? truncation.truncatedCalls : undefined,
		};
		messages.push(toolCallMsg);

		// ── 等待执行 + 渲染 ──
		const drainPromise = renderBuffer.drain(renderer, () => {}, options?.signal);
		await Promise.all([runPromise, drainPromise]);

		// ── 按原始顺序 push domain messages ──
		for (const job of scheduler.orderedJobs()) {
			if (job.argError) {
				messages.push(job.argError);
			} else if (job.result) {
				messages.push(job.result);
			}
		}

		// ── 截断消息（由 truncation 模块生成） ──
		for (const msg of truncation.messages) {
			messages.push(msg);
		}

		// ── submit 处理 ──
		let earlyReturn: AgentResult<T> | null = null;
		for (const job of scheduler.orderedJobs()) {
			if (!job.result || job.result.tool !== "submit") continue;
			const validation = validateSubmit(job.result.cleanedResult, options?.schema);
			if (validation.ok) {
				renderer.submitAccepted();
				earlyReturn = {
					result: validation.value,
					report: job.result.call.args.report ?? null,
					history: messages,
				};
			} else {
				submitRetries++;
				if (submitRetries >= MAX_SUBMIT_RETRIES) {
					renderer.submitRejected(submitRetries, MAX_SUBMIT_RETRIES, `giving up after ${submitRetries} attempts`);
					earlyReturn = { result: null, report: `Submit validation failed after ${MAX_SUBMIT_RETRIES} retries: ${validation.error}`, history: messages };
				} else {
					renderer.submitRejected(submitRetries, MAX_SUBMIT_RETRIES, validation.error);
					messages.push({ type: "submit:rejected", error: validation.error, attempt: submitRetries, maxAttempts: MAX_SUBMIT_RETRIES });
				}
			}
			break;
		}

		if (earlyReturn) return earlyReturn;
	}

	return { result: null, report: `Agent terminated: max iterations (${maxIter}) exceeded`, history: messages };
}

// ── 辅助函数 ──

function validateSubmit<T = unknown>(
	raw: unknown,
	schema?: ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
	if (!schema) return { ok: true, value: raw as T };
	const result = schema.safeParse(raw);
	if (result.success) return { ok: true, value: result.data };
	const issues = result.error.issues.map((i) => `  ${String(i.path.join("."))}: ${i.message}`).join("\n");
	let fullSchema: string;
	try { fullSchema = JSON.stringify(toJSONSchema(schema), null, 2); } catch { fullSchema = "(schema serialization failed)"; }
	return { ok: false, error: `Result does not match expected schema:\n${issues}\n\nFull expected schema:\n${fullSchema}` };
}

function injectReminders(messages: DomainMessage[], reminders: PendingReminder[]): void {
	const due: PendingReminder[] = [];
	const remaining: PendingReminder[] = [];
	for (const r of reminders) {
		r.roundsLeft--;
		if (r.roundsLeft <= 0) due.push(r);
		else remaining.push(r);
	}
	reminders.length = 0;
	reminders.push(...remaining);
	for (const r of due) {
		messages.push({ type: "reminder:due", content: r.content, originalDelay: r.originalDelay });
	}
}
