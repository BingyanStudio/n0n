/**
 * Workspace 路径工具 — 通用路径解析与目录管理
 *
 * 提供最小路径集（BaseWorkspacePaths）和通用工具函数。
 * 路径解析为纯函数，无全局状态。
 *
 * 扩展路径集（如 WorkflowPaths）由各业务包自行定义。
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

// ── 路径解析（纯函数）──

/** 解析 base 路径 — 最小路径集 */
export function resolveBasePaths(workspace: string): BaseWorkspacePaths {
	const ws = resolve(workspace);
	return {
		workspace: ws,
		temp: resolve(ws, ".temp"),
	};
}

// ── 目录创建 ──

/** 确保路径对象中所有目录存在 — 只创建传入对象中实际存在的字段 */
export function ensureDirs(paths: Record<string, string>): void {
	for (const dir of Object.values(paths)) {
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
