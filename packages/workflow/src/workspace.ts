/**
 * WorkflowPaths — workflow builder 场景的完整路径集
 *
 * 扩展 BaseWorkspacePaths，添加 workflow 特有的目录。
 * CLI / Feishu 模式使用。
 */

import { resolve } from "node:path";
import type { BaseWorkspacePaths } from "@n0n/shared";

/** CLI / Feishu 模式 — workflow builder 场景 */
export interface WorkflowPaths extends BaseWorkspacePaths {
	workflows: string;
	tasks: string;
	skills: string;
	schedules: string;
	memory: string;
	consultResult: string;
	history: string;
}

/** 解析 workflow 路径 — cli/feishu 模式使用 */
export function resolveWorkflowPaths(workspace: string): WorkflowPaths {
	const ws = resolve(workspace);
	return {
		workspace: ws,
		temp: resolve(ws, ".temp"),
		workflows: resolve(ws, "workflows"),
		tasks: resolve(ws, "workflows", "tasks"),
		skills: resolve(ws, "workflows", "skills"),
		schedules: resolve(ws, "workflows", "schedules"),
		memory: resolve(ws, "workflows", "memory"),
		consultResult: resolve(ws, "workflows", "consult-result"),
		history: resolve(ws, "workflows", "history"),
	};
}
