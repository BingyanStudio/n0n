/**
 * Workflow 执行运行时
 *
 * Workflow = TypeScript 文件，import { agentLoop, delegateTask } 等原语。
 * 运行时负责加载和执行这些文件。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";
import type { WorkflowMeta } from "../types.ts";
import type { WorkflowPaths } from "../workspace.ts";

export type WorkflowDiscoveryPaths = Pick<WorkflowPaths, "tasks" | "skills">;

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
	includeSkills = false,
	paths: WorkflowDiscoveryPaths,
): Promise<WorkflowMeta[]> {
	const scanTargets = includeSkills
		? [
				{ dir: paths.tasks, label: "tasks" },
				{ dir: paths.skills, label: "skills" },
			]
		: [{ dir: paths.tasks, label: "tasks" }];

	const results: WorkflowMeta[] = [];

	for (const { dir, label } of scanTargets) {
		const absDir = resolve(dir);
		if (!existsSync(absDir)) continue;

		const glob = new Glob("**/*.ts");
		const relFiles = Array.from(glob.scanSync({ cwd: absDir }));

		for (const rel of relFiles) {
			const file = resolve(absDir, rel);
			const content = await Bun.file(file).text();
			const descMatch = content.match(
				/^\/\*\*?\s*\n?\s*\*?\s*(.+?)(?:\n|\s*\*\/)/,
			);
			const description = descMatch?.[1]?.trim() ?? "";

			const name = `${label}/${rel.replace(/\\/g, "/")}`.replace(/\.ts$/, "");

			results.push({ name, path: file, description });
		}
	}

	return results;
}

/**
 * 执行一个 workflow 文件
 *
 * @param cwd 可选，执行时的工作目录。传入后会在执行期间切换 process.cwd()，
 *            执行完成后恢复。用于 scheduler / commands 等需要 cwd 隔离的场景。
 */
export async function runWorkflow(
	workflowPath: string,
	args?: unknown,
	cwd?: string,
): Promise<unknown> {
	const absPath = resolve(workflowPath);

	if (!existsSync(absPath)) {
		throw new Error(`Workflow not found: ${workflowPath}`);
	}

	const mod = (await import(absPath)) as WorkflowModule;

	const entryFn = mod.default ?? mod.run;

	if (typeof entryFn !== "function") {
		const exports = Object.keys(mod).filter((k) => k !== "__esModule");
		throw new Error(
			`Workflow ${workflowPath} must export a default function or a named 'run' function.\n` +
				`Found exports: [${exports.join(", ")}]\n` +
				`See WorkflowModule interface in @n0n/workflow for the expected contract.`,
		);
	}

	if (cwd) {
		const originalCwd = process.cwd();
		try {
			process.chdir(cwd);
			return await entryFn(args);
		} finally {
			process.chdir(originalCwd);
		}
	}

	return entryFn(args);
}
