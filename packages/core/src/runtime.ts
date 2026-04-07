/**
 * RuntimeContext — 替代所有全局可变单例
 *
 * 从 app 入口构造，通过参数显式传递到各层（包括 LLM / tools）。
 * 如需共享，可在应用入口集中构造 RuntimeContext 再下发使用。
 *
 * 依赖反转：RuntimeContext 只依赖 LLMClient 接口（@n0n/types），
 * 不直接依赖 @n0n/llm。Client 实例由 app 入口构造并注入。
 */

import type { LLMClient } from "@n0n/types";
import type { ResponsesClient } from "@n0n/tools";

// ── 类型 ──

export interface AgentConfig {
	maxIterations: number;
	maxIdleRounds: number;
	defaultExecTimeout: number;
}

export interface SecurityConfig {
	blockedCommands: string[];
}

/** 编辑后端配置 — discriminated union，与 ToolsConfig 的 edit 部分对齐 */
export type EditBackendConfig =
	| { type: "str-replace"; editorClient: LLMClient }
	| { type: "freeform-patch"; responsesClient: ResponsesClient };

export interface RuntimeContext {
	/** 主 LLM Client 实例 */
	readonly client: LLMClient;
	/** 编辑后端配置 */
	readonly editBackend: EditBackendConfig;
	readonly agent: AgentConfig;
	readonly security: SecurityConfig;
}

// ── 构造参数 ──

export interface RuntimeOptions {
	/** 主 LLM Client */
	client: LLMClient;
	/**
	 * 编辑后端配置。
	 * - 不传或 type="str-replace": 使用 Editor LLM 多轮 str_replace 循环
	 * - type="freeform-patch": 使用 OpenAI Responses API + freeform patch 单次调用
	 *
	 * str-replace 模式下 editorClient 可省略，默认复用 client。
	 */
	editBackend?: EditBackendConfig | { type: "str-replace"; editorClient?: LLMClient };
	/** Agent 配置覆盖 */
	agent?: Partial<AgentConfig>;
	/** 安全配置覆盖 */
	security?: Partial<SecurityConfig>;
}

// ── 从环境变量解析辅助配置 ──

function parseBlockedCommands(): string[] {
	const raw = process.env.BLOCKED_COMMANDS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((c) => c.trim())
		.filter((c) => c.length > 0);
}

/**
 * 构造 RuntimeContext
 *
 * Client 实例由调用方（app 入口）创建并注入，
 * 实现 @n0n/core 与 @n0n/llm 的依赖反转。
 */
export function createRuntimeContext(options: RuntimeOptions): RuntimeContext {
	let editBackend: EditBackendConfig;
	if (options.editBackend?.type === "freeform-patch") {
		editBackend = options.editBackend as EditBackendConfig;
	} else {
		const editorClient =
			(options.editBackend as { editorClient?: LLMClient } | undefined)?.editorClient
			?? options.client;
		editBackend = { type: "str-replace", editorClient };
	}

	return {
		client: options.client,
		editBackend,
		agent: {
			maxIterations: options.agent?.maxIterations ?? 50,
			maxIdleRounds: options.agent?.maxIdleRounds ?? 5,
			defaultExecTimeout: options.agent?.defaultExecTimeout ?? 120,
		},
		security: {
			blockedCommands:
				options.security?.blockedCommands ?? parseBlockedCommands(),
		},
	};
}

// ── 运行时上下文全局单例 ──

let _runtime: RuntimeContext | null = null;

/** 获取当前运行时上下文（必须先通过 initRuntime 初始化） */
export function getRuntime(): RuntimeContext {
	if (!_runtime) {
		throw new Error(
			"RuntimeContext not initialized. Call initRuntime() from app entry point first.",
		);
	}
	return _runtime;
}

/** 设置运行时上下文。各 app 入口调用。 */
export function initRuntime(runtime: RuntimeContext): void {
	_runtime = runtime;
}
