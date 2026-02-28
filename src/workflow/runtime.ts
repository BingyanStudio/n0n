/**
 * Workflow 执行运行时
 *
 * Workflow = TypeScript 文件，import { subagent, delegateTask } 等原语。
 * 运行时负责加载和执行这些文件。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

export interface WorkflowMeta {
	name: string;
	path: string;
	description: string;
}

/**
 * 发现所有 workflow（扫描 workflows/ 目录）
 */
export async function discoverWorkflows(
	baseDir = "workflows",
): Promise<WorkflowMeta[]> {
	const results: WorkflowMeta[] = [];
	const dirs = ["skills", "tasks"];

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
export async function runWorkflow(workflowPath: string): Promise<unknown> {
	const absPath = resolve(workflowPath);

	if (!existsSync(absPath)) {
		throw new Error(`Workflow not found: ${workflowPath}`);
	}

	// Bun 原生支持动态 import .ts 文件
	const mod = await import(absPath);

	// 约定：workflow 导出 default 函数或 run 函数
	const entryFn = mod.default ?? mod.run;

	if (typeof entryFn !== "function") {
		throw new Error(
			`Workflow ${workflowPath} must export a default function or a 'run' function`,
		);
	}

	return entryFn();
}
