/**
 * Agent Loop v2 — 纯编排层
 *
 * 每一步都是一个清晰的函数调用：
 * 1. parseStream  → 流式解析，yield 语义事件
 * 2. scheduler    → 流水线并行执行（streaming 中工具就绪即入队）
 * 3. renderBuffer → FIFO 有序渲染
 * 4. round.*      → 纯函数后处理（截断恢复、消息构建、submit 检查）
 *
 * 本文件不包含 phase tracking、JSON 解析、截断恢复等细节。
 */

import type { PendingReminder, ToolsConfig } from "@n0n/tools";
import { makeToolkit } from "@n0n/tools";
import type { DomainMessage, Renderer, ToolCallRecord } from "@n0n/types";
import { FinishReason } from "@n0n/types";
import type { ZodType } from "zod";
import { getRuntime } from "../runtime.ts";
import { PlainRenderer } from "../ui/renderer.ts";
import { RenderBuffer } from "../agent/render-buffer.ts";
import { ExecutionScheduler } from "../agent/scheduler.ts";
import { executeToolStream } from "../agent/tool.ts";
import { parseStream, type StreamingResult } from "./streaming.ts";
import {
	recoverTruncatedCalls,
	buildToolCallMessage,
	collectJobMessages,
	checkSubmit,
} from "./round.ts";

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

// ── Agent Loop ──

export async function agentLoop<T = unknown>(
	client: { stream: any; modelId: string },
	toolsConfig: ToolsConfig,
	messages: DomainMessage[],
	options?: AgentOptions<T>,
): Promise<AgentResult<T>> {
	const maxIter = options?.maxIterations ?? getRuntime().agent.maxIterations;
	const renderer: Renderer = options?.renderer ?? new PlainRenderer();
	const toolkit = await makeToolkit(options?.schema, toolsConfig, client.modelId);
	const reminders: PendingReminder[] = [];
	let idleCount = 0;
	let submitRetries = 0;
	let lastUsage = null as any;

	for (let iter = 0; iter < maxIter; iter++) {
		if (options?.signal?.aborted) {
			renderer.aborted();
			return { result: null, report: null, history: messages };
		}

		injectReminders(messages, reminders);
		renderer.roundStart(iter + 1, maxIter, messages.length, lastUsage);

		// ── 1. 流式解析 + 并行执行（交织进行） ──
		const scheduler = new ExecutionScheduler((tc) =>
			executeToolStream(tc, reminders, options?.confirmFn, toolkit.getEntry),
		);
		const renderBuffer = new RenderBuffer();
		scheduler.attachRenderBuffer(renderBuffer);
		const runPromise = scheduler.run(options?.signal);

		let streamResult: StreamingResult | null = null;

		for await (const event of parseStream(
			client.stream({ messages, tools: toolkit.tools, toolChoice: "auto" }, options?.signal),
			options?.signal,
		)) {
			switch (event.type) {
				// 渲染分发（一行一个，无逻辑）
				case "thinking_chunk":  renderer.thinkingChunk(event.text); break;
				case "thinking_end":    renderer.thinkingEnd(); break;
				case "content_chunk":   renderer.contentChunk(event.text); break;
				case "content_end":     renderer.contentEnd(); break;
				case "tool_arg_start":  renderer.toolCallArgStart(event.index, event.name); break;
				case "tool_arg_chunk":  renderer.toolCallArgChunk(event.index, event.chunk); break;

				// 工具就绪 → 渲染 + 入队调度
				case "tool_ready":
					renderer.toolCallArgEnd(event.index, event.tc);
					scheduler.enqueue(event.tc);
					break;

				// streaming 完毕
				case "done":
					streamResult = event.result;
					break;
			}
		}
		renderer.streamEnd();
		lastUsage = streamResult!.accumulator.usage;

		// ── 2. 快速退出路径 ──
		const earlyExit = handleEarlyExit(streamResult!, scheduler, renderer, messages);
		if (earlyExit) return earlyExit as AgentResult<T>;
		if (earlyExit === null && handleNoToolCalls(streamResult!, scheduler, renderer, messages, idleCount, getRuntime().agent.maxIdleRounds)) {
			idleCount++;
			if (idleCount >= getRuntime().agent.maxIdleRounds) {
				const content = streamResult!.accumulator.content || "";
				renderer.agentTerminated("max idle rounds exceeded (no tool calls)");
				return { result: null, report: `Agent terminated: max idle rounds exceeded. Last content: ${content.slice(0, 200)}`, history: messages };
			}
			messages.push({ type: "idle_nudge", idleCount, maxIdleRounds: getRuntime().agent.maxIdleRounds });
			continue;
		}

		idleCount = 0;

		// ── 3. 截断恢复 + seal ──
		const truncation = recoverTruncatedCalls(streamResult!);
		const allTools: ToolCallRecord[] = [...streamResult!.readyTools.values()];
		for (const tc of truncation.recoveredTools) {
			allTools.push(tc);
			scheduler.enqueue(tc);
		}
		scheduler.seal();

		if (allTools.length === 0 && truncation.truncatedCalls.length === 0) continue;

		// ── 4. 构建 assistant 消息 ──
		messages.push(buildToolCallMessage(
			streamResult!.accumulator,
			allTools,
			truncation.truncatedCalls,
		));

		// ── 5. 等待执行 + 渲染完成 ──
		await Promise.all([
			runPromise,
			renderBuffer.drain(renderer, () => {}, options?.signal),
		]);

		// ── 6. 收集结果消息 ──
		messages.push(...collectJobMessages(scheduler.orderedJobs()));
		for (const msg of truncation.messages) messages.push(msg);

		// ── 7. Submit 检查 ──
		const submit = checkSubmit(scheduler.orderedJobs(), options?.schema, submitRetries, MAX_SUBMIT_RETRIES);
		if (submit.accepted) {
			renderer.submitAccepted();
			return { result: submit.accepted.value as T, report: submit.accepted.report, history: messages };
		}
		if (submit.gaveUp) {
			renderer.submitRejected(submitRetries + 1, MAX_SUBMIT_RETRIES, `giving up after ${submitRetries + 1} attempts`);
			return { result: null, report: `Submit validation failed after ${MAX_SUBMIT_RETRIES} retries: ${submit.gaveUp.error}`, history: messages };
		}
		if (submit.rejected) {
			submitRetries = submit.rejected.retries;
			renderer.submitRejected(submitRetries, MAX_SUBMIT_RETRIES, submit.rejected.error);
			messages.push({ type: "submit:rejected", error: submit.rejected.error, attempt: submitRetries, maxAttempts: MAX_SUBMIT_RETRIES });
		}
	}

	return { result: null, report: `Agent terminated: max iterations (${maxIter}) exceeded`, history: messages };
}

// ── 辅助：快速退出判断 ──

function handleEarlyExit(
	result: StreamingResult,
	scheduler: ExecutionScheduler,
	renderer: Renderer,
	messages: DomainMessage[],
): AgentResult<any> | undefined {
	// aborted，无任何工具 → 直接返回
	if (result.interrupt === "aborted" && result.readyTools.size === 0) {
		scheduler.seal();
		renderer.aborted();
		return { result: null, report: null, history: messages } as AgentResult<any>;
	}

	// error，无工具 → 终止
	if (result.interrupt === "error" && result.readyTools.size === 0) {
		scheduler.seal();
		renderer.agentTerminated("LLM error");
		return { result: null, report: "LLM stream error", history: messages } as AgentResult<any>;
	}

	// content_filter → 终止
	if (result.accumulator.finishReason === FinishReason.CONTENT_FILTER) {
		scheduler.seal();
		messages.push({
			type: "assistant_text",
			content: result.accumulator.content || "",
			reasoning: result.accumulator.reasoning || undefined,
			reasoningSignature: result.accumulator.reasoningSignature || undefined,
		});
		renderer.agentTerminated("Content was filtered by the model provider.");
		return { result: null, report: "Agent terminated: content filter triggered", history: messages } as AgentResult<any>;
	}

	return undefined; // 无需快速退出
}

function handleNoToolCalls(
	result: StreamingResult,
	scheduler: ExecutionScheduler,
	renderer: Renderer,
	messages: DomainMessage[],
	idleCount: number,
	maxIdleRounds: number,
): boolean {
	const hasTools = result.readyTools.size > 0;
	const hasIncomplete = result.accumulator.toolCalls.size > result.readyTools.size;

	if (hasTools || hasIncomplete) return false;

	// length 截断且无工具 → 告知模型重试
	if (result.interrupt === "length") {
		scheduler.seal();
		messages.push({
			type: "assistant_text",
			content: result.accumulator.content || "",
			reasoning: result.accumulator.reasoning || undefined,
			reasoningSignature: result.accumulator.reasoningSignature || undefined,
		});
		messages.push({
			type: "user_text",
			content: "Your previous response was truncated due to max_tokens limit. Please retry with a shorter response, or break the task into smaller steps.",
		});
		return false; // 不算 idle，直接 continue
	}

	// 纯文本回复 → idle
	scheduler.seal();
	const content = result.accumulator.content ?? "";
	messages.push({
		type: "assistant_text",
		content,
		reasoning: result.accumulator.reasoning || undefined,
		reasoningSignature: result.accumulator.reasoningSignature || undefined,
	});
	return true; // 是 idle
}

// ── Reminders ──

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
