/**
 * 全局配置 — 过渡层
 *
 * PR 1: 路径相关代码已迁移到 workspace.ts / runtime.ts
 * 保留 initConfig 作为兼容桥接，内部委托给新模块。
 * 后续 PR 2-4 会继续消除 LLM/tools 全局单例。
 */

import { initLLMConfig } from "@n0n/llm";
import { initToolsConfig } from "@n0n/tools";
import {
	type RuntimeContext,
	createRuntimeContext,
} from "./runtime.ts";
import {
	type BaseWorkspacePaths,
	type WorkflowPaths,
	ensureDirs,
	resolveWorkflowPaths,
} from "./workspace.ts";

// ── 运行时上下文（过渡期全局单例，PR 2-3 消除）──

let _runtime: RuntimeContext | null = null;

export function getRuntime(): RuntimeContext {
	if (!_runtime) {
		_runtime = createRuntimeContext();
	}
	return _runtime;
}

// ── 初始化 LLM + Tools（过渡期，保留全局 init）──

/**
 * 初始化 LLM 和 Tools 子包配置。
 * 路径相关逻辑已移除，由各 app 自行管理。
 */
export function initRuntime(
	runtime: RuntimeContext,
	paths: BaseWorkspacePaths,
): void {
	_runtime = runtime;
	initLLMConfig(runtime.llm);
	initToolsConfig({
		security: runtime.security,
		agent: runtime.agent,
		workspace: paths.workspace,
		tempDir: paths.temp,
	});
}

// ── 向后兼容导出（后续 PR 逐步移除）──

/** @deprecated 使用 workspace.ts 中的 WorkflowPaths */
export type WorkspacePaths = WorkflowPaths;

/** @deprecated 使用 workspace.ts 中的路径解析函数 */
export interface PathConfig {
	workspace?: string;
	workflows?: string;
	tasks?: string;
	skills?: string;
	schedules?: string;
	memory?: string;
	consultResult?: string;
	history?: string;
	temp?: string;
}

/** @deprecated 使用 resolveWorkflowPaths / resolveBasePaths */
export function resolvePaths(pathConfig: PathConfig = {}): WorkflowPaths {
	return resolveWorkflowPaths(pathConfig.workspace ?? process.cwd());
}
