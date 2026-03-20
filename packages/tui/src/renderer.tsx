/**
 * TuiRenderer — Ink-based TUI 渲染器
 *
 * 实现 Renderer 接口，将事件转换为 React 状态。
 * 使用 Ink 的 render() 函数管理终端输出。
 */

import type { Renderer, ToolCallRecord, ToolResult } from "@n0n/types";
import { render } from "ink";
import React from "react";
import { TuiApp } from "./components/App.tsx";
import {
	createInitialState,
	stateUpdaters,
	type TuiRendererState,
} from "./state.ts";

export class TuiRenderer implements Renderer {
	private state: TuiRendererState = createInitialState();
	private setState!: React.Dispatch<React.SetStateAction<TuiRendererState>>;
	private inkInstance: ReturnType<typeof render> | null = null;

	constructor() {
		// 创建一个简单的状态管理
		// Ink 的 render() 需要一个 React 组件，我们通过闭包传递 state
		const StatefulApp = () => {
			const [localState, setLocalState] = React.useState(this.state);
			this.setState = setLocalState;
			return <TuiApp state={localState} />;
		};

		this.inkInstance = render(<StatefulApp />);
	}

	private updateState(updater: (s: TuiRendererState) => TuiRendererState) {
		this.state = updater(this.state);
		this.setState(this.state);
	}

	userMessage(content: string): void {
		this.updateState((s) => stateUpdaters.userMessage(s, content));
	}

	roundStart(
		round: number,
		maxRounds: number,
		msgCount: number,
		_lastUsage?: import("@n0n/types").RoundTokenUsage | null,
	): void {
		this.updateState((s) =>
			stateUpdaters.roundStart(s, round, maxRounds, msgCount),
		);
	}

	thinkingToken(token: string): void {
		this.updateState((s) => stateUpdaters.thinkingToken(s, token));
	}

	contentToken(token: string): void {
		this.updateState((s) => stateUpdaters.contentToken(s, token));
	}

	contentEnd(): void {
		this.updateState((s) => stateUpdaters.contentEnd(s));
	}

	textResponse(content: string, idleCount: number): void {
		this.updateState((s) => ({
			...s,
			messages: [
				...s.messages,
				{
					id: `msg-${Date.now()}`,
					type: "content" as const,
					content: `(text response, ${content.length} chars, idle=${idleCount})`,
					timestamp: Date.now(),
				},
			],
		}));
	}

	toolCallStart(tc: ToolCallRecord): void {
		this.updateState((s) => stateUpdaters.toolCallStart(s, tc));
	}

	toolCallArgChunk(
		index: number,
		name: string | undefined,
		chunk: string,
	): void {
		this.updateState((s) =>
			stateUpdaters.toolCallArgChunk(s, index, name, chunk),
		);
	}

	toolResultChunk(tool: string, chunk: string): void {
		this.updateState((s) => stateUpdaters.toolResultChunk(s, tool, chunk));
	}

	toolCallEnd(result: ToolResult): void {
		this.updateState((s) => stateUpdaters.toolCallEnd(s, result));
	}

	submitAccepted(): void {
		this.updateState((s) => stateUpdaters.submitAccepted(s));
	}

	submitRejected(attempt: number, maxAttempts: number, error: string): void {
		this.updateState((s) =>
			stateUpdaters.submitRejected(s, attempt, maxAttempts, error),
		);
	}

	agentTerminated(reason: string): void {
		this.updateState((s) => stateUpdaters.agentTerminated(s, reason));
	}

	aborted(): void {
		this.updateState((s) => stateUpdaters.aborted(s));
	}

	/** 清理资源 */
	dispose(): void {
		this.inkInstance?.unmount();
		this.inkInstance = null;
	}
}
