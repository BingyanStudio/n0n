/**
 * TuiRendererState — TUI 渲染器状态（指令式事件模型）
 *
 * 将 Renderer 接口的事件转换为 React 状态。
 * 所有阶段转换由上游指令驱动，不做推断。
 */

import type { ToolCallRecord, ToolResult } from "@n0n/types";

export interface StreamingToolCall {
	index: number;
	name: string;
	args: string;
}

export interface CompletedToolCall {
	id: string;
	tool: string;
	args: Record<string, unknown>;
	status: "running" | "completed" | "failed";
	output?: string;
	result?: ToolResult;
	startTime: number;
	durationMs?: number;
}

export interface Message {
	id: string;
	type: "user" | "agent" | "thinking" | "content" | "tool" | "system";
	content: string;
	timestamp: number;
}

export interface TuiRendererState {
	messages: Message[];
	streamingToolCalls: Map<number, StreamingToolCall>;
	completedToolCalls: CompletedToolCall[];
	thinkingContent: string;
	contentBuffer: string;
	round: { current: number; max: number; msgCount: number } | null;
	finalStatus:
		| "idle"
		| "submit_accepted"
		| "submit_rejected"
		| "terminated"
		| "aborted"
		| null;
	submitError: { attempt: number; maxAttempts: number; error: string } | null;
	terminationReason: string | null;
}

let messageIdCounter = 0;
const generateId = () => `msg-${++messageIdCounter}`;

export function createInitialState(): TuiRendererState {
	return {
		messages: [],
		streamingToolCalls: new Map(),
		completedToolCalls: [],
		thinkingContent: "",
		contentBuffer: "",
		round: null,
		finalStatus: null,
		submitError: null,
		terminationReason: null,
	};
}

/** 状态更新函数（指令式事件模型） */
export const stateUpdaters = {
	userMessage: (
		state: TuiRendererState,
		content: string,
	): TuiRendererState => ({
		...state,
		messages: [
			...state.messages,
			{ id: generateId(), type: "user" as const, content, timestamp: Date.now() },
		],
	}),

	roundStart: (
		state: TuiRendererState,
		round: number,
		maxRounds: number,
		msgCount: number,
		_lastUsage?: import("@n0n/types").RoundTokenUsage | null,
	): TuiRendererState => ({
		...state,
		round: { current: round, max: maxRounds, msgCount },
		thinkingContent: "",
		contentBuffer: "",
		streamingToolCalls: new Map(),
	}),

	thinkingChunk: (
		state: TuiRendererState,
		token: string,
	): TuiRendererState => ({
		...state,
		thinkingContent: state.thinkingContent + token,
	}),

	thinkingEnd: (state: TuiRendererState): TuiRendererState => {
		if (!state.thinkingContent) return state;
		return {
			...state,
			messages: [
				...state.messages,
				{ id: generateId(), type: "thinking", content: state.thinkingContent, timestamp: Date.now() },
			],
			thinkingContent: "",
		};
	},

	contentChunk: (state: TuiRendererState, token: string): TuiRendererState => ({
		...state,
		contentBuffer: state.contentBuffer + token,
	}),

	toolCallArgStart: (
		state: TuiRendererState,
		index: number,
		name: string,
	): TuiRendererState => {
		const newMap = new Map(state.streamingToolCalls);
		newMap.set(index, { index, name, args: "" });
		return { ...state, streamingToolCalls: newMap };
	},

	toolCallArgChunk: (
		state: TuiRendererState,
		index: number,
		chunk: string,
	): TuiRendererState => {
		const newMap = new Map(state.streamingToolCalls);
		const existing = newMap.get(index);
		if (existing) {
			newMap.set(index, { ...existing, args: existing.args + chunk });
		}
		return { ...state, streamingToolCalls: newMap };
	},

	toolCallArgEnd: (
		state: TuiRendererState,
		index: number,
		_tc: ToolCallRecord,
	): TuiRendererState => {
		const newMap = new Map(state.streamingToolCalls);
		newMap.delete(index);
		return { ...state, streamingToolCalls: newMap };
	},

	streamEnd: (state: TuiRendererState): TuiRendererState => {
		const newMessages: Message[] = [];
		if (state.contentBuffer) {
			newMessages.push({
				id: generateId(),
				type: "content",
				content: state.contentBuffer,
				timestamp: Date.now(),
			});
		}
		return {
			...state,
			messages: [...state.messages, ...newMessages],
			contentBuffer: "",
			streamingToolCalls: new Map(),
		};
	},

	toolExecStart: (
		state: TuiRendererState,
		tc: ToolCallRecord,
	): TuiRendererState => ({
		...state,
		completedToolCalls: [
			...state.completedToolCalls,
			{
				id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				tool: tc.tool,
				args: tc.args as Record<string, unknown>,
				status: "running",
				startTime: Date.now(),
			},
		],
	}),

	toolExecChunk: (
		state: TuiRendererState,
		tool: string,
		chunk: string,
	): TuiRendererState => {
		const calls = [...state.completedToolCalls];
		for (let i = calls.length - 1; i >= 0; i--) {
			const call = calls[i];
			if (call && call.tool === tool && call.status === "running") {
				calls[i] = { ...call, output: (call.output ?? "") + chunk };
				break;
			}
		}
		return { ...state, completedToolCalls: calls };
	},

	toolExecEnd: (
		state: TuiRendererState,
		result: ToolResult,
	): TuiRendererState => {
		const calls = state.completedToolCalls.map((call) => {
			if (call.tool === result.tool && call.status === "running") {
				const isSuccess =
					result.tool === "exec"
						? result.exitCode === 0
						: result.tool === "submit" || result.tool === "reminder"
							? true
							: result.success;
				return {
					...call,
					status: (isSuccess ? "completed" : "failed") as "completed" | "failed",
					result,
					durationMs: Date.now() - call.startTime,
				};
			}
			return call;
		});
		return { ...state, completedToolCalls: calls };
	},

	submitAccepted: (state: TuiRendererState): TuiRendererState => ({
		...state,
		finalStatus: "submit_accepted",
	}),

	submitRejected: (
		state: TuiRendererState,
		attempt: number,
		maxAttempts: number,
		error: string,
	): TuiRendererState => ({
		...state,
		finalStatus: "submit_rejected",
		submitError: { attempt, maxAttempts, error },
	}),

	agentTerminated: (state: TuiRendererState, reason: string): TuiRendererState => ({
		...state,
		finalStatus: "terminated",
		terminationReason: reason,
	}),

	aborted: (state: TuiRendererState): TuiRendererState => ({
		...state,
		finalStatus: "aborted",
		thinkingContent: "",
		contentBuffer: "",
		streamingToolCalls: new Map(),
	}),
};
