/**
 * PlainRenderer — 向后兼容的默认渲染器
 *
 * 最小化实现，用于非交互场景（delegateTask、workflow 等）。
 */

import type {
	Renderer,
	RoundTokenUsage,
	ToolCallRecord,
	ToolResult,
} from "@n0n/types";

export class PlainRenderer implements Renderer {
	userMessage(_content: string): void {}

	roundStart(
		round: number,
		maxRounds: number,
		msgCount: number,
		lastUsage?: RoundTokenUsage | null,
	): void {
		const usagePart = lastUsage ? ` | ${lastUsage.totalTokens} tok` : "";
		console.error(
			`  [agent] round ${round}/${maxRounds} (${msgCount} msgs${usagePart})`,
		);
	}

	thinkingChunk(_token: string): void {}
	thinkingEnd(): void {}
	contentChunk(_token: string): void {}
	contentEnd(): void {}

	toolCallArgStart(_index: number, _name: string): void {}
	toolCallArgChunk(_index: number, _chunk: string): void {}
	toolCallArgEnd(_index: number, _tc: ToolCallRecord): void {}
	streamEnd(): void {}

	textResponse(content: string, idleCount: number): void {
		console.error(
			`  [agent] text response (${content.length} chars), idle=${idleCount}`,
		);
	}

	toolExecStart(_tcId: string, tc: ToolCallRecord): void {
		const suffix =
			tc.tool === "exec" ? ` → ${tc.args.script.slice(0, 80)}` : "";
		console.error(`  [agent] tool: ${tc.tool}${suffix}`);
	}

	toolExecChunk(_tcId: string, _tool: string, _chunk: string): void {}
	toolExecEnd(_tcId: string, _result: ToolResult | null): void {}

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
