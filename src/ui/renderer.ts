/**
 * Renderer — 事件驱动的终端渲染抽象
 *
 * agentLoop 产生事件，Renderer 决定如何展示。
 * PlainRenderer 复刻现有 console.error 行为（向后兼容）。
 * RichRenderer（Phase 3）实现彩色标签、流式输出、行替换。
 */

import type { ToolCallRecord, ToolResult } from "../types/domain.ts";

// ── Renderer 接口 ──

export interface Renderer {
	/** 用户输入展示 */
	userMessage(content: string): void;

	/** 新一轮 LLM 调用开始 */
	roundStart(round: number, maxRounds: number, msgCount: number): void;

	/** LLM 流式输出：thinking token（灰色） */
	thinkingToken(token: string): void;

	/** LLM 流式输出：content token（白色） */
	contentToken(token: string): void;

	/** LLM 输出结束 */
	contentEnd(): void;

	/** LLM 纯文本回复（非流式回退） */
	textResponse(content: string, idleCount: number): void;

	/** 工具调用开始 */
	toolCallStart(tc: ToolCallRecord): void;

	/** 工具调用流式参数片段（用于实时渲染参数） */
	toolCallArgChunk(
		index: number,
		name: string | undefined,
		chunk: string,
	): void;

	/** 工具执行过程中的流式输出 chunk（如 exec 的 stdout/stderr） */
	toolResultChunk(tool: string, chunk: string): void;

	/** 工具调用完成，展示结果 */
	toolCallEnd(result: ToolResult): void;

	/** submit 被接受 */
	submitAccepted(): void;

	/** submit 被拒绝 */
	submitRejected(attempt: number, maxAttempts: number, error: string): void;

	/** agent 终止（超时/空转） */
	agentTerminated(reason: string): void;
}

// ── PlainRenderer — 向后兼容 ──

export class PlainRenderer implements Renderer {
	userMessage(_content: string): void {
		// main.ts 已经打印了用户输入，这里不重复
	}

	roundStart(round: number, maxRounds: number, msgCount: number): void {
		console.error(`  [agent] round ${round}/${maxRounds} (${msgCount} msgs)`);
	}

	thinkingToken(_token: string): void {
		// 非流式模式下不触发
	}

	contentToken(_token: string): void {
		// 非流式模式下不触发
	}

	contentEnd(): void {
		// 非流式模式下不触发
	}

	textResponse(content: string, idleCount: number): void {
		console.error(
			`  [agent] text response (${content.length} chars), idle=${idleCount}`,
		);
	}

	toolCallStart(tc: ToolCallRecord): void {
		const suffix =
			tc.tool === "exec"
				? ` → ${(tc.args as { command?: string }).command?.slice(0, 80)}`
				: "";
		console.error(`  [agent] tool: ${tc.tool}${suffix}`);
	}

	toolCallArgChunk(
		_index: number,
		_name: string | undefined,
		_chunk: string,
	): void {
		// 非流式模式下不触发
	}

	toolResultChunk(_tool: string, _chunk: string): void {
		// PlainRenderer 不处理流式 chunk
	}

	toolCallEnd(_result: ToolResult): void {
		// PlainRenderer 不额外打印工具结果（exec 工具自己会输出 stdout/stderr）
	}

	submitAccepted(): void {
		console.error("  [agent] submit accepted ✓");
	}

	submitRejected(attempt: number, maxAttempts: number, error: string): void {
		console.error(
			`  [agent] submit rejected (${attempt}/${maxAttempts}): ${error}`,
		);
	}

	agentTerminated(reason: string): void {
		console.error(`  [agent] ${reason}`);
	}
}
