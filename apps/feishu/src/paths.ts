/**
 * Feishu 工作区路径解析 — 纯函数，无全局副作用
 *
 * 每个飞书用户拥有独立的工作区：`.runtime/feishu/<senderOpenId>`
 * 其中 skills 和 consultResult 在用户间共享（`.runtime/feishu/shared/`），
 * 其余目录为 per-user 隔离。
 */

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureDirs } from "@n0n/shared";
import type { WorkflowPaths } from "@n0n/workflow";

const FEISHU_BASE = resolve(
	process.env.N0N_FEISHU_WORKSPACE ??
		resolve(process.cwd(), ".runtime", "feishu"),
);
const SHARED_DIR = resolve(FEISHU_BASE, "shared");

/**
 * 查找项目根目录（包含 tsconfig.json 的最近祖先）。
 * 优先使用源文件位置推算（编译时确定），回退到 cwd 和 FEISHU_BASE 向上查找。
 */
function findProjectRoot(): string {
	// 1. 基于源文件位置：apps/feishu/src/ → 项目根
	const fromSource = resolve(import.meta.dir, "..", "..", "..");
	if (existsSync(resolve(fromSource, "tsconfig.json"))) return fromSource;

	// 2. 基于 cwd
	if (existsSync(resolve(process.cwd(), "tsconfig.json"))) return process.cwd();

	// 3. 从 FEISHU_BASE 向上查找
	let dir = FEISHU_BASE;
	const root = resolve(dir, "/");
	while (dir !== root) {
		if (existsSync(resolve(dir, "tsconfig.json"))) return dir;
		dir = resolve(dir, "..");
	}

	// 最后回退到 cwd
	return process.cwd();
}

/**
 * 为指定飞书用户解析工作区路径（纯函数，不修改全局配置）。
 *
 * - per-user: workspace, workflows, tasks, schedules, memory, history, temp
 * - shared:   skills, consultResult
 */
export function resolveFeishuPaths(senderOpenId: string): WorkflowPaths {
	const workspace = resolve(FEISHU_BASE, senderOpenId);
	const paths: WorkflowPaths = {
		workspace,
		workflows: resolve(workspace, "workflows"),
		tasks: resolve(workspace, "workflows", "tasks"),
		skills: resolve(SHARED_DIR, "skills"),
		schedules: resolve(workspace, "workflows", "schedules"),
		memory: resolve(workspace, "workflows", "memory"),
		consultResult: resolve(SHARED_DIR, "consult-result"),
		history: resolve(workspace, "workflows", "history"),
		temp: resolve(workspace, ".temp"),
	};

	ensureDirs(paths);

	// 确保用户 workspace 有 tsconfig.json，使 bun 能解析 @n0n/* 等路径映射
	const tsconfigPath = resolve(workspace, "tsconfig.json");
	if (!existsSync(tsconfigPath)) {
		const projectRoot = findProjectRoot();
		const rootTsconfig = resolve(projectRoot, "tsconfig.json");
		if (existsSync(rootTsconfig)) {
			const tsconfig = JSON.stringify(
				{ extends: rootTsconfig },
				null,
				"\t",
			);
			writeFileSync(tsconfigPath, tsconfig);
		}
	}
	return paths;
}

/**
 * 扫描所有已有用户目录，返回每个用户的 WorkflowPaths。
 * 跳过 shared/ 目录。
 */
export function discoverAllUserPaths(): WorkflowPaths[] {
	if (!existsSync(FEISHU_BASE)) return [];

	const entries = readdirSync(FEISHU_BASE);
	const results: WorkflowPaths[] = [];

	for (const entry of entries) {
		if (entry === "shared") continue;
		const fullPath = resolve(FEISHU_BASE, entry);
		if (!statSync(fullPath).isDirectory()) continue;
		results.push(resolveFeishuPaths(entry));
	}

	return results;
}
