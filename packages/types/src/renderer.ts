/**
 * Renderer — 指令式事件驱动的渲染抽象
 *
 * agentLoop（上游）产生明确的阶段开始/结束指令，Renderer（下游）只响应指令，不做推断。
 * 所有阶段转换由 loop.ts 驱动，Renderer 不需要维护内部状态来猜测当前处于什么阶段。
 *
 * 事件分三个阶段：
 * 1. LLM 流式输出：thinkingChunk → thinkingEnd → contentChunk → toolCallArg* → streamEnd
 * 2. 工具执行：toolExecStart → toolExecChunk → toolExecEnd
 * 3. 特殊事件：submitAccepted / submitRejected / agentTerminated / aborted
 */

import type { ToolCallRecord, ToolResult } from "./domain.ts";

/** 单轮 LLM 调用的 token 用量统计 */
export interface RoundTokenUsage {
	/** 新计算的输入 token 数（不含缓存命中部分，各 provider 已统一为此语义） */
	inputTokens: number;
	/** 输出 token 总量 */
	outputTokens: number;
	/** 总 token 量 */
	totalTokens: number;
	/** 缓存命中的输入 token 数 */
	cacheReadTokens: number;
	/** 写入缓存的输入 token 数 */
	cacheWriteTokens: number;
}

export interface Renderer {
	/** 用户输入展示 */
	userMessage(content: string): void;

	/** 新一轮 LLM 调用开始 */
	roundStart(
		round: number,
		maxRounds: number,
		msgCount: number,
		lastUsage?: RoundTokenUsage | null,
	): void;

	// ── LLM 流式输出（上游：SSE 流驱动） ──

	/** thinking token chunk */
	thinkingChunk(token: string): void;

	/** thinking 阶段结束（仅在有 thinking 输出时由上游触发） */
	thinkingEnd(): void;

	/** content token chunk */
	contentChunk(token: string): void;

	/** 某个工具调用的参数流开始（上游首次遇到该 index 时触发） */
	toolCallArgStart(index: number, name: string): void;

	/** 某个工具调用的参数 chunk */
	toolCallArgChunk(index: number, chunk: string): void;

	/** 某个工具调用的参数流结束（上游检测到 JSON 完整时触发） */
	toolCallArgEnd(index: number, tc: ToolCallRecord): void;

	/**
	 * LLM 流式输出全部结束（阶段终结信号）
	 *
	 * 无论正常完成还是异常中断都会触发，Renderer 应清理所有 streaming 状态。
	 * 异常原因由后续事件（agentTerminated 等）传达。
	 */
	streamEnd(): void;

	// ── 工具执行（上游：本地顺序驱动） ──

	/** 工具开始执行 */
	toolExecStart(tc: ToolCallRecord): void;

	/** 工具执行过程中的流式输出 chunk */
	toolExecChunk(tool: string, chunk: string): void;

	/** 工具执行完成 */
	toolExecEnd(result: ToolResult): void;

	// ── 特殊事件 ──

	/** LLM 纯文本回复（非流式回退） */
	textResponse(content: string, idleCount: number): void;

	/** submit 被接受 */
	submitAccepted(): void;

	/** submit 被拒绝 */
	submitRejected(attempt: number, maxAttempts: number, error: string): void;

	/** agent 终止 */
	agentTerminated(reason: string): void;

	/** 用户中断（Ctrl+C）— 清理流式输出状态 */
	aborted(): void;
}
