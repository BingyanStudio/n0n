/**
 * Workspace 路径体系 — Base + Extend 模式
 *
 * - BaseWorkspacePaths: 所有模式共享的最小路径集 (code 模式)
 * - WorkflowPaths: workflow builder 场景的完整路径集 (cli/feishu 模式)
 *
 * 路径解析为纯函数，无全局状态。目录创建按实际字段进行，不创建多余目录。
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ── 类型 ──

/** 所有模式共享的最小路径集 */
export interface BaseWorkspacePaths {
	/** 工作区根目录（绝对路径） */
	workspace: string;
	/** 临时文件目录 */
	temp: string;
}

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

// ── 路径解析（纯函数）──

/** 解析 base 路径 — code 模式使用 */
export function resolveBasePaths(workspace: string): BaseWorkspacePaths {
	const ws = resolve(workspace);
	return {
		workspace: ws,
		temp: resolve(ws, ".temp"),
	};
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

// ── 目录创建 ──

/** 确保路径对象中所有目录存在 — 只创建传入对象中实际存在的字段 */
export function ensureDirs(paths: BaseWorkspacePaths | WorkflowPaths): void {
	for (const dir of Object.values(paths) as string[]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}

// ── CLI 参数解析 ──

/**
 * 从命令行参数中解析 --workspace 选项。
 * 返回解析后的 workspace 绝对路径和剩余参数。
 */
export function parseWorkspaceArg(
	args: string[],
	envKey: string,
	defaultPath: string,
): { workspace: string; remainingArgs: string[] } {
	const remaining = [...args];
	const idx = remaining.indexOf("--workspace");
	let workspaceValue: string | undefined;

	if (idx >= 0) {
		workspaceValue = remaining[idx + 1];
		if (!workspaceValue) {
			throw new Error("--workspace requires a directory argument");
		}
		remaining.splice(idx, 2);
	}

	const workspace = resolve(
		workspaceValue ?? process.env[envKey] ?? defaultPath,
	);

	return { workspace, remainingArgs: remaining };
}
