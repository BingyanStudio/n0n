/**
 * PlainRenderer — 向后兼容的默认渲染器
 *
 * 最小化实现，用于非交互场景（delegateTask、workflow 等）。
 */

import type { Renderer, ToolCallRecord, ToolResult } from "@n0n/types";

export class PlainRenderer implements Renderer {
	userMessage(_content: string): void {}

	roundStart(round: number, maxRounds: number, msgCount: number): void {
		console.error(`  [agent] round ${round}/${maxRounds} (${msgCount} msgs)`);
	}

	thinkingToken(_token: string): void {}
	contentToken(_token: string): void {}
	contentEnd(): void {}

	textResponse(content: string, idleCount: number): void {
		console.error(
			`  [agent] text response (${content.length} chars), idle=${idleCount}`,
		);
	}

	toolCallStart(tc: ToolCallRecord): void {
		const suffix =
			tc.tool === "exec" ? ` → ${tc.args.script.slice(0, 80)}` : "";
		console.error(`  [agent] tool: ${tc.tool}${suffix}`);
	}

	toolCallArgChunk(
		_index: number,
		_name: string | undefined,
		_chunk: string,
	): void {}

	toolResultChunk(_tool: string, _chunk: string): void {}
	toolCallEnd(_result: ToolResult): void {}

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

	aborted(): void {
		console.error("  [agent] aborted by user");
	}
}
