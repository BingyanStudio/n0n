/**
 * 全局配置 — 过渡层
 *
 * PR 1: 路径相关代码已迁移到 workspace.ts / runtime.ts
 * PR 2: LLM 配置已改为显式传递
 * PR 3: Tools 配置已改为显式传递
 * PR 4 将清理此文件为最终形态。
 */

import {
	type RuntimeContext,
	createRuntimeContext,
} from "./runtime.ts";
import {
	type WorkflowPaths,
	resolveWorkflowPaths,
} from "./workspace.ts";

// ── 运行时上下文（仍为全局单例，agentLoop 内部通过 getRuntime() 读取）──

let _runtime: RuntimeContext | null = null;

export function getRuntime(): RuntimeContext {
	if (!_runtime) {
		_runtime = createRuntimeContext();
	}
	return _runtime;
}

/**
 * 设置运行时上下文。各 app 入口调用。
 */
export function initRuntime(runtime: RuntimeContext): void {
	_runtime = runtime;
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
