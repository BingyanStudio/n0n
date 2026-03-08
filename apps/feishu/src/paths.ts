/**
 * Feishu 工作区路径解析 — 纯函数，无全局副作用
 *
 * 每个飞书用户拥有独立的工作区：`.runtime/feishu/<senderOpenId>`
 * 其中 skills 和 consultResult 在用户间共享（`.runtime/feishu/shared/`），
 * 其余目录为 per-user 隔离。
 *
 * 此模块仅做路径计算，不调用 initConfig，避免并发请求间的全局状态竞争。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkspacePaths } from "@n0n/core";

const FEISHU_BASE = resolve(
	process.env.N0N_FEISHU_WORKSPACE ??
		resolve(process.cwd(), ".runtime", "feishu"),
);
const SHARED_DIR = resolve(FEISHU_BASE, "shared");

/**
 * 为指定飞书用户解析工作区路径（纯函数，不修改全局配置）。
 *
 * - per-user: workspace, workflows, tasks, schedules, memory, history, temp
 * - shared:   skills, consultResult
 */
export function resolveFeishuPaths(senderOpenId: string): WorkspacePaths {
	const workspace = resolve(FEISHU_BASE, senderOpenId);
	return {
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
}

/**
 * 扫描所有已有用户目录，返回每个用户的 WorkspacePaths。
 * 跳过 shared/ 目录。
 */
export function discoverAllUserPaths(): WorkspacePaths[] {
	if (!existsSync(FEISHU_BASE)) return [];

	const entries = readdirSync(FEISHU_BASE);
	const results: WorkspacePaths[] = [];

	for (const entry of entries) {
		if (entry === "shared") continue;
		const fullPath = resolve(FEISHU_BASE, entry);
		if (!statSync(fullPath).isDirectory()) continue;
		results.push(resolveFeishuPaths(entry));
	}

	return results;
}
