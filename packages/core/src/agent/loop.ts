/**
 * Agent Loop — 纯编排层
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
import type {
	DomainMessage,
	PartialToolCallRecord,
	Renderer,
	TokenUsage,
	ToolCallRecord,
} from "@n0n/types";
import { FinishReason } from "@n0n/types";
import type { ZodType } from "zod";
import { getRuntime } from "../runtime.ts";
import { PlainRenderer } from "../ui/renderer.ts";
import { RenderBuffer } from "./render-buffer.ts";
import {
	buildToolCallMessage,
	checkSubmit,
	collectJobMessages,
	recoverTruncatedCalls,
} from "./round.ts";
import { ExecutionScheduler } from "./scheduler.ts";
import { parseStream, type StreamingResult } from "./streaming.ts";
import { executeToolStream } from "./tool.ts";

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
	history: DomainMessage[],
	options?: AgentOptions<T>,
): Promise<AgentResult<T>> {
	const runtime = getRuntime();
	const maxIter = options?.maxIterations ?? runtime.agent.maxIterations;
	const renderer: Renderer = options?.renderer ?? new PlainRenderer();
	const client = runtime.client;
	const toolsConfig: ToolsConfig = {
		security: runtime.security,
		agent: runtime.agent,
		editorClient: runtime.editorClient,
		...(options?.toolsWorkspace ?? {
			workspace: process.cwd(),
			tempDir: ".temp",
		}),
	};
	const toolkit = await makeToolkit(
		options?.schema,
		toolsConfig,
		client.modelId,
	);
	const messages: DomainMessage[] = [...history];
	const reminders: PendingReminder[] = [];
	let idleCount = 0;
	let submitRetries = 0;
	let lastUsage = null as TokenUsage | null;

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
			client.stream(
				{ messages, tools: toolkit.tools, toolChoice: "auto" },
				options?.signal,
			),
			options?.signal,
		)) {
			switch (event.type) {
				// 渲染分发
				case "thinking_chunk":
					renderer.thinkingChunk(event.text);
					break;
				case "thinking_end":
					renderer.thinkingEnd();
					break;
				case "content_chunk":
					renderer.contentChunk(event.text);
					break;
				case "content_end":
					renderer.contentEnd();
					break;
				case "tool_arg_start":
					renderer.toolCallArgStart(event.index, event.name);
					break;
				case "tool_arg_chunk":
					renderer.toolCallArgChunk(event.index, event.chunk);
					break;

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
		// biome-ignore lint/style/noNonNullAssertion: streamResult is always set by the stream loop above
		lastUsage = streamResult!.accumulator.usage;

		// ── 2. 分类本轮结果，决定后续动作 ──
		const outcome = classifyRound(
			// biome-ignore lint/style/noNonNullAssertion: streamResult is always set by the stream loop above
			streamResult!,
			messages,
			idleCount,
			runtime.agent.maxIdleRounds,
		);

		if (outcome.action === "exit") {
			scheduler.seal();
			if (outcome.reason === "aborted") renderer.aborted();
			else renderer.agentTerminated(outcome.reason);
			return { result: null, report: outcome.report, history: messages };
		}

		if (outcome.action === "idle") {
			scheduler.seal();
			idleCount++;
			if (idleCount >= runtime.agent.maxIdleRounds) {
				renderer.agentTerminated("max idle rounds exceeded (no tool calls)");
				return {
					result: null,
					// biome-ignore lint/style/noNonNullAssertion: streamResult is always set by the stream loop above
					report: `Agent terminated: max idle rounds exceeded. Last content: ${(streamResult!.accumulator.content || "").slice(0, 200)}`,
					history: messages,
				};
			}
			messages.push({
				type: "idle_nudge",
				idleCount,
				maxIdleRounds: runtime.agent.maxIdleRounds,
			});
			continue;
		}

		if (outcome.action === "retry_truncated") {
			scheduler.seal();
			continue;
		}

		// outcome.action === "execute_tools"
		idleCount = 0;

		// ── 3. 截断恢复 + seal ──
		const tryRecover = async (
			toolName: string,
			toolCallId: string,
			partialJson: string,
		) => {
			const entry = toolkit.getEntry(toolName);
			return (
				(await entry?.recoverAndExecute?.(toolCallId, partialJson)) ?? null
			);
		};
		// biome-ignore lint/style/noNonNullAssertion: streamResult is always set by the stream loop above
		const truncation = await recoverTruncatedCalls(streamResult!, tryRecover);
		scheduler.seal();

		// 合并所有工具调用：streaming 完成的 + 截断恢复的
		const allCalls: (ToolCallRecord | PartialToolCallRecord)[] = [
			// biome-ignore lint/style/noNonNullAssertion: streamResult is always set by the stream loop above
			...streamResult!.readyTools.values(),
			...truncation.pairs.map((p) => p.call),
		];

		if (allCalls.length === 0) continue;

		// ── 4. 构建 assistant 消息 ──
		// biome-ignore lint/style/noNonNullAssertion: streamResult is always set by the stream loop above
		messages.push(buildToolCallMessage(streamResult!.accumulator, allCalls));

		// ── 5. 等待执行 + 渲染完成 ──
		await Promise.all([
			runPromise,
			renderBuffer.drain(renderer, () => {}, options?.signal),
		]);

		// ── 6. 收集结果消息 ──
		messages.push(...collectJobMessages(scheduler.orderedJobs()));
		// 截断恢复的 result 已由 truncation 产出（recover 内执行完毕）
		for (const pair of truncation.pairs) {
			messages.push(pair.result);
		}

		// ── 7. Submit 检查 ──
		const submit = checkSubmit(
			scheduler.orderedJobs(),
			options?.schema,
			submitRetries,
			MAX_SUBMIT_RETRIES,
		);
		if (submit.accepted) {
			renderer.submitAccepted();
			return {
				result: submit.accepted.value as T,
				report: submit.accepted.report,
				history: messages,
			};
		}
		if (submit.gaveUp) {
			renderer.submitRejected(
				submitRetries + 1,
				MAX_SUBMIT_RETRIES,
				`giving up after ${submitRetries + 1} attempts`,
			);
			return {
				result: null,
				report: `Submit validation failed after ${MAX_SUBMIT_RETRIES} retries: ${submit.gaveUp.error}`,
				history: messages,
			};
		}
		if (submit.rejected) {
			submitRetries = submit.rejected.retries;
			renderer.submitRejected(
				submitRetries,
				MAX_SUBMIT_RETRIES,
				submit.rejected.error,
			);
			messages.push({
				type: "submit:rejected",
				error: submit.rejected.error,
				attempt: submitRetries,
				maxAttempts: MAX_SUBMIT_RETRIES,
			});
		}
	}

	return {
		result: null,
		report: `Agent terminated: max iterations (${maxIter}) exceeded`,
		history: messages,
	};
}

// ── 本轮结果分类（纯函数） ──

type RoundOutcome =
	| { action: "exit"; reason: string; report: string | null }
	| { action: "idle" }
	| { action: "retry_truncated" }
	| { action: "execute_tools" };

function classifyRound(
	result: StreamingResult,
	messages: DomainMessage[],
	_idleCount: number,
	_maxIdleRounds: number,
): RoundOutcome {
	const hasReadyTools = result.readyTools.size > 0;
	const hasIncomplete =
		result.accumulator.toolCalls.size > result.readyTools.size;
	const hasAnyTools = hasReadyTools || hasIncomplete;

	// aborted，无任何工具 → 直接返回
	if (result.interrupt === "aborted" && !hasAnyTools) {
		return { action: "exit", reason: "aborted", report: null };
	}

	// error，无工具 → 终止
	if (result.interrupt === "error" && !hasReadyTools) {
		return { action: "exit", reason: "LLM error", report: "LLM stream error" };
	}

	// content_filter → 终止
	if (result.accumulator.finishReason === FinishReason.CONTENT_FILTER) {
		messages.push({
			type: "assistant_text",
			content: result.accumulator.content || "",
			reasoning: result.accumulator.reasoning || undefined,
			reasoningSignature: result.accumulator.reasoningSignature || undefined,
		});
		return {
			action: "exit",
			reason: "Content was filtered by the model provider.",
			report: "Agent terminated: content filter triggered",
		};
	}

	// length 截断且无工具 → 告知模型重试
	if (result.interrupt === "length" && !hasAnyTools) {
		messages.push({
			type: "assistant_text",
			content: result.accumulator.content || "",
			reasoning: result.accumulator.reasoning || undefined,
			reasoningSignature: result.accumulator.reasoningSignature || undefined,
		});
		messages.push({
			type: "user_text",
			content:
				"Your previous response was truncated due to max_tokens limit. Please retry with a shorter response, or break the task into smaller steps.",
		});
		return { action: "retry_truncated" };
	}

	// 无工具调用 → idle
	if (!hasAnyTools) {
		const content = result.accumulator.content ?? "";
		messages.push({
			type: "assistant_text",
			content,
			reasoning: result.accumulator.reasoning || undefined,
			reasoningSignature: result.accumulator.reasoningSignature || undefined,
		});
		return { action: "idle" };
	}

	// 有工具调用 → 执行
	return { action: "execute_tools" };
}

// ── Reminders ──

function injectReminders(
	messages: DomainMessage[],
	reminders: PendingReminder[],
): void {
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
		messages.push({
			type: "reminder:due",
			content: r.content,
			originalEstimate: r.originalEstimate,
		});
	}
}
