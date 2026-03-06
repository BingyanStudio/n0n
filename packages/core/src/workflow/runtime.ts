/**
 * Workflow 执行运行时
 *
 * Workflow = TypeScript 文件，import { agentLoop, delegateTask } 等原语。
 * 运行时负责加载和执行这些文件。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";
import { paths } from "../config.ts";

export interface WorkflowMeta {
	name: string;
	path: string;
	description: string;
}

/**
 * Workflow 模块接口 — workflow 文件必须导出以下之一：
 * - `export default async function(args?) { ... }`
 * - `export async function run(args?) { ... }`
 */
export interface WorkflowModule {
	default?: (args?: unknown) => Promise<unknown> | unknown;
	run?: (args?: unknown) => Promise<unknown> | unknown;
}

/**
 * 发现所有 workflow（扫描 workflows/ 目录）
 */
export async function discoverWorkflows(
	baseDir = paths.workflows,
	includeSkills = false,
): Promise<WorkflowMeta[]> {
	const results: WorkflowMeta[] = [];
	const dirs = includeSkills ? ["skills", "tasks"] : ["tasks"];
	const absBase = resolve(baseDir);

	for (const sub of dirs) {
		const dir = resolve(absBase, sub);
		if (!existsSync(dir)) continue;

		const glob = new Glob("**/*.ts");
		const relFiles = Array.from(glob.scanSync({ cwd: dir }));

		for (const rel of relFiles) {
			const file = resolve(dir, rel);
			const content = await Bun.file(file).text();
			const descMatch = content.match(
				/^\/\*\*?\s*\n?\s*\*?\s*(.+?)(?:\n|\s*\*\/)/,
			);
			const description = descMatch?.[1]?.trim() ?? "";

			const name = `${sub}/${rel.replace(/\\/g, "/")}`.replace(/\.ts$/, "");

			results.push({ name, path: file, description });
		}
	}

	return results;
}

/**
 * 执行一个 workflow 文件
 */
export async function runWorkflow(
	workflowPath: string,
	args?: unknown,
): Promise<unknown> {
	const absPath = resolve(workflowPath);

	if (!existsSync(absPath)) {
		throw new Error(`Workflow not found: ${workflowPath}`);
	}

	// Bun 原生支持动态 import .ts 文件
	const mod = (await import(absPath)) as WorkflowModule;

	// 查找入口函数：优先 default export，其次 named export `run`
	const entryFn = mod.default ?? mod.run;

	if (typeof entryFn !== "function") {
		const exports = Object.keys(mod).filter((k) => k !== "__esModule");
		throw new Error(
			`Workflow ${workflowPath} must export a default function or a named 'run' function.\n` +
				`Found exports: [${exports.join(", ")}]\n` +
				`See WorkflowModule interface in @n0n/core for the expected contract.`,
		);
	}

	return entryFn(args);
}
