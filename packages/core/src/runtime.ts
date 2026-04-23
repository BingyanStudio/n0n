/**
 * RuntimeContext — 替代所有全局可变单例
 *
 * 从 app 入口构造，通过参数显式传递到各层（包括 LLM / tools）。
 * 如需共享，可在应用入口集中构造 RuntimeContext 再下发使用。
 *
 * 依赖反转：RuntimeContext 只依赖 LLMClient 接口（@n0n/types），
 * 不直接依赖 @n0n/llm。Client 实例由 app 入口构造并注入。
 */

import type { ResponsesClient, ToolsConfig } from "@n0n/tools";
import type { LLMClient } from "@n0n/types";

// ── 类型 ──

export interface AgentConfig {
	maxIterations: number;
	maxIdleRounds: number;
	defaultExecWaitfor: number;
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
	/** 编辑后端配置 */
	editBackend: EditBackendConfig;
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

export function createRuntimeContext(options: RuntimeOptions): RuntimeContext {
	return {
		client: options.client,
		editBackend: options.editBackend,
		agent: {
			maxIterations: options.agent?.maxIterations ?? 50,
			maxIdleRounds: options.agent?.maxIdleRounds ?? 5,
			defaultExecWaitfor: options.agent?.defaultExecWaitfor ?? 120,
		},
		security: {
			blockedCommands:
				options.security?.blockedCommands ?? parseBlockedCommands(),
		},
	};
}

// ── 运行时上下文全局单例 ──

// TODO: review — getRuntime() 全局单例在多 agent 场景下可能成为瓶颈，
// 考虑改为 RuntimeContext 参数透传。当前调用方仅 loop.ts 和 rag.ts，改动范围可控。
// 等其他 TODO 解决后再具体讨论。
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

/** 从 RuntimeContext + 工作区路径构建 ToolsConfig — 供 app 层调用 makeToolkit 使用 */
export function buildToolsConfig(
	runtime: RuntimeContext,
	paths: { workspace: string; tempDir: string },
): ToolsConfig {
	const base = {
		security: runtime.security,
		agent: runtime.agent,
		workspace: paths.workspace,
		tempDir: paths.tempDir,
	};
	if (runtime.editBackend.type === "freeform-patch") {
		return {
			...base,
			editBackendType: "freeform-patch",
			responsesClient: runtime.editBackend.responsesClient,
		};
	}
	return {
		...base,
		editBackendType: "str-replace",
		editorClient: runtime.editBackend.editorClient,
	};
}
