/**
 * Renderer — 事件驱动的渲染抽象（纯接口契约）
 *
 * agentLoop 产生事件，Renderer 决定如何展示。
 * 具体实现由各 app 提供（CLI RichRenderer、Feishu Renderer 等）。
 */

import type { ToolCallRecord, ToolResult } from "./domain.ts";

export interface Renderer {
	/** 用户输入展示 */
	userMessage(content: string): void;

	/** 新一轮 LLM 调用开始 */
	roundStart(round: number, maxRounds: number, msgCount: number): void;

	/** LLM 流式输出：thinking token */
	thinkingToken(token: string): void;

	/** LLM 流式输出：content token */
	contentToken(token: string): void;

	/** LLM 输出结束 */
	contentEnd(): void;

	/** LLM 纯文本回复（非流式回退） */
	textResponse(content: string, idleCount: number): void;

	/** 工具调用开始 */
	toolCallStart(tc: ToolCallRecord): void;

	/** 工具调用流式参数片段 */
	toolCallArgChunk(
		index: number,
		name: string | undefined,
		chunk: string,
	): void;

	/** 工具执行过程中的流式输出 chunk */
	toolResultChunk(tool: string, chunk: string): void;

	/** 工具调用完成 */
	toolCallEnd(result: ToolResult): void;

	/** submit 被接受 */
	submitAccepted(): void;

	/** submit 被拒绝 */
	submitRejected(attempt: number, maxAttempts: number, error: string): void;

	/** agent 终止 */
	agentTerminated(reason: string): void;
}
