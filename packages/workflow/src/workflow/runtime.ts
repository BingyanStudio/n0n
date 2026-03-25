/**
 * Workflow 执行运行时
 *
 * Workflow = TypeScript 文件，import { agentLoop, delegateTask } 等原语。
 * 运行时负责加载和执行这些文件。
 *
 * 当需要 CWD 隔离时（scheduler / commands），通过 Bun.spawn 在子进程中执行，
 * 避免 process.chdir 的进程级竞态条件。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** runner.ts 的绝对路径（编译时确定） */
const RUNNER_PATH = resolve(import.meta.dir, "runner.ts");

/**
 * 在子进程中执行 workflow，实现真正的进程级 CWD 隔离。
 * 结果通过临时文件传递，避免与 workflow 自身的 stdout 混淆。
 */
async function runWorkflowIsolated(
	workflowPath: string,
	args: unknown | undefined,
	cwd: string,
): Promise<unknown> {
	const resultFile = join(
		tmpdir(),
		`n0n-wf-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
	);

	const spawnArgs = ["bun", "run", RUNNER_PATH, workflowPath];
	if (args !== undefined) spawnArgs.push(JSON.stringify(args));

	const proc = Bun.spawn(spawnArgs, {
		cwd,
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env, __N0N_RESULT_FILE__: resultFile },
	});

	const exitCode = await proc.exited;

	// 读取结果文件
	let resultJson: { ok: boolean; value?: unknown; error?: string };
	try {
		const raw = readFileSync(resultFile, "utf8");
		resultJson = JSON.parse(raw);
	} catch {
		throw new Error(
			`Workflow subprocess failed (exit ${exitCode}), no result file produced.`,
		);
	} finally {
		try {
			unlinkSync(resultFile);
		} catch {
			// ignore cleanup errors
		}
	}

	if (!resultJson.ok) {
		throw new Error(resultJson.error ?? "Workflow failed (unknown error)");
	}

	return resultJson.value;
}

/**
 * 执行一个 workflow 文件
 *
 * @param cwd 可选，执行时的工作目录。传入后通过 Bun.spawn 在独立子进程中执行，
 *            实现进程级 CWD 隔离，避免并发竞态。
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

	// 需要 CWD 隔离时，在子进程中执行
	if (cwd) {
		return runWorkflowIsolated(absPath, args, cwd);
	}

	// 无 CWD 需求时，直接在当前进程中执行
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

	return entryFn(args);
}
