/**
 * Renderer — 事件驱动的渲染抽象
 *
 * 按 block 拆分为独立子接口，每个 block 有完整的 start/chunk/end 生命周期。
 * 实现方可逐模块实现，按需组合。
 *
 * 一轮的事件流：
 *   roundStart
 *     thinking  { start → chunk* → end }
 *     content   { start → chunk* → end }
 *     toolCallArg* { start → chunk* → end }   (per tool, within stream)
 *   streamEnd
 *     toolExec* { start → chunk* → end }      (per tool, 无序到达)
 *   roundEnd
 */

import type { ToolCallRecord, ToolExecOutcome } from "./domain.ts";

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

// ── Block 子接口 ──

/** thinking 块：LLM 推理过程的流式输出 */
export interface ThinkingRenderer {
	thinkingStart(): void;
	thinkingChunk(token: string): void;
	thinkingEnd(): void;
}

/** content 块：LLM 正文内容的流式输出 */
export interface ContentRenderer {
	contentStart(): void;
	contentChunk(token: string): void;
	contentEnd(): void;
}

/** 工具参数块：单个工具调用参数的流式输出（stream 阶段，按 index 区分） */
export interface ToolCallArgRenderer {
	toolCallArgStart(index: number, name: string): void;
	toolCallArgChunk(index: number, chunk: string): void;
	toolCallArgEnd(index: number, tc: ToolCallRecord): void;
}

/** 工具执行块：单个工具执行过程的流式输出（无序到达，按 tcId 区分） */
export interface ToolExecRenderer {
	toolExecStart(tcId: string, tc: ToolCallRecord): void;
	toolExecChunk(tcId: string, tool: string, chunk: string): void;
	toolExecEnd(tcId: string, outcome: ToolExecOutcome): void;
}

// ── 完整 Renderer ──

export interface Renderer
	extends ThinkingRenderer,
		ContentRenderer,
		ToolCallArgRenderer,
		ToolExecRenderer {
	/** 用户输入展示 */
	userMessage(content: string): void;

	/** 新一轮开始 */
	roundStart(
		round: number,
		maxRounds: number,
		msgCount: number,
		lastUsage?: RoundTokenUsage | null,
	): void;

	/** 本轮结束 */
	roundEnd(): void;

	/**
	 * LLM 流式输出全部结束（阶段终结信号）
	 *
	 * thinking/content/toolCallArg 各 block 均已通过自身的 end 关闭。
	 * streamEnd 标记整个 LLM 响应接收完毕，执行阶段可以开始渲染。
	 * 异常原因由后续事件（agentTerminated 等）传达。
	 */
	streamEnd(): void;

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
