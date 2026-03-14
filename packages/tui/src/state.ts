/**
 * TuiRendererState — TUI 渲染器状态
 *
 * 将 Renderer 接口的事件转换为 React 状态。
 * 支持流式输出和多工具并行显示。
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
	/** 消息列表 */
	messages: Message[];

	/** 当前正在流式输出的工具调用（参数尚未完整） */
	streamingToolCalls: Map<number, StreamingToolCall>;

	/** 已完成的工具调用（正在执行或已完成） */
	completedToolCalls: CompletedToolCall[];

	/** 当前思考内容（流式） */
	thinkingContent: string;

	/** 当前回复内容（流式） */
	contentBuffer: string;

	/** 是否正在思考阶段 */
	isThinking: boolean;

	/** 当前轮次信息 */
	round: { current: number; max: number; msgCount: number } | null;

	/** 最终状态 */
	finalStatus:
		| "idle"
		| "submit_accepted"
		| "submit_rejected"
		| "terminated"
		| "aborted"
		| null;

	/** submit 拒绝信息 */
	submitError: { attempt: number; maxAttempts: number; error: string } | null;

	/** 终止原因 */
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
		isThinking: false,
		round: null,
		finalStatus: null,
		submitError: null,
		terminationReason: null,
	};
}

/** 状态更新函数 */
export const stateUpdaters = {
	userMessage: (
		state: TuiRendererState,
		content: string,
	): TuiRendererState => ({
		...state,
		messages: [
			...state.messages,
			{
				id: generateId(),
				type: "user" as const,
				content,
				timestamp: Date.now(),
			},
		],
	}),

	roundStart: (
		state: TuiRendererState,
		round: number,
		maxRounds: number,
		msgCount: number,
	): TuiRendererState => ({
		...state,
		round: { current: round, max: maxRounds, msgCount },
		thinkingContent: "",
		contentBuffer: "",
		isThinking: false,
		streamingToolCalls: new Map(),
	}),

	thinkingToken: (
		state: TuiRendererState,
		token: string,
	): TuiRendererState => ({
		...state,
		thinkingContent: state.thinkingContent + token,
		isThinking: true,
	}),

	contentToken: (state: TuiRendererState, token: string): TuiRendererState => ({
		...state,
		contentBuffer: state.contentBuffer + token,
		isThinking: false,
	}),

	contentEnd: (state: TuiRendererState): TuiRendererState => {
		const newMessages: Message[] = [];

		// 将 thinking 内容添加到消息
		if (state.thinkingContent) {
			newMessages.push({
				id: generateId(),
				type: "thinking",
				content: state.thinkingContent,
				timestamp: Date.now(),
			});
		}

		// 将 content 内容添加到消息
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
			thinkingContent: "",
			contentBuffer: "",
			isThinking: false,
			streamingToolCalls: new Map(),
		};
	},

	toolCallArgChunk: (
		state: TuiRendererState,
		index: number,
		name: string | undefined,
		chunk: string,
	): TuiRendererState => {
		const newMap = new Map(state.streamingToolCalls);
		const existing = newMap.get(index);

		newMap.set(index, {
			index,
			name: name ?? existing?.name ?? "?",
			args: (existing?.args ?? "") + chunk,
		});

		return {
			...state,
			streamingToolCalls: newMap,
		};
	},

	toolCallStart: (
		state: TuiRendererState,
		tc: ToolCallRecord,
	): TuiRendererState => {
		const newCall: CompletedToolCall = {
			id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			tool: tc.tool,
			args: tc.args as Record<string, unknown>,
			status: "running",
			startTime: Date.now(),
		};

		return {
			...state,
			completedToolCalls: [...state.completedToolCalls, newCall],
		};
	},

	toolResultChunk: (
		state: TuiRendererState,
		tool: string,
		chunk: string,
	): TuiRendererState => {
		// 找到最近的一个运行中的该类型工具，追加输出
		const calls = [...state.completedToolCalls];
		for (let i = calls.length - 1; i >= 0; i--) {
			const call = calls[i];
			if (call && call.tool === tool && call.status === "running") {
				calls[i] = {
					...call,
					output: (call.output ?? "") + chunk,
				};
				break;
			}
		}

		return {
			...state,
			completedToolCalls: calls,
		};
	},

	toolCallEnd: (
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
					status: (isSuccess ? "completed" : "failed") as
						| "completed"
						| "failed",
					result,
					durationMs: Date.now() - call.startTime,
				};
			}
			return call;
		});

		return {
			...state,
			completedToolCalls: calls,
		};
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

	agentTerminated: (
		state: TuiRendererState,
		reason: string,
	): TuiRendererState => ({
		...state,
		finalStatus: "terminated",
		terminationReason: reason,
	}),

	aborted: (state: TuiRendererState): TuiRendererState => ({
		...state,
		finalStatus: "aborted",
		thinkingContent: "",
		contentBuffer: "",
		isThinking: false,
		streamingToolCalls: new Map(),
	}),
};
