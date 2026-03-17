/**
 * Harbor 评测模拟 Runner
 *
 * 模拟 Harbor Trial 流程，在本地运行 n0n code agent 完成 task。
 * 不依赖 Docker — 直接在本地临时目录中运行。
 *
 * 用法：
 *   bun run scripts/harbor-sim.ts                          运行所有 task
 *   bun run scripts/harbor-sim.ts --task django__django-15098  运行指定 task
 *   bun run scripts/harbor-sim.ts --list                   列出所有 task
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createRuntimeContext, initRuntime } from "@n0n/core";
import { ensureDirs, resolveBasePaths } from "@n0n/shared";
import { runHeadless, type HeadlessResult } from "../apps/code/src/headless.ts";

// ── 配置 ──

const TASKS_DIR = resolve(import.meta.dir, "../data/harbor-tasks");
const RESULTS_DIR = resolve(import.meta.dir, "../data/harbor-results");
const WORKSPACES_DIR = resolve(import.meta.dir, "../data/harbor-workspaces");

interface TaskMeta {
	name: string;
	instruction: string;
	difficulty: string;
	category: string;
	timeoutSec: number;
}

// ── Task 加载 ──

function loadTask(taskDir: string): TaskMeta {
	const instruction = readFileSync(
		resolve(taskDir, "instruction.md"),
		"utf8",
	);

	let difficulty = "unknown";
	let category = "unknown";
	let timeoutSec = 900;

	const tomlPath = resolve(taskDir, "task.toml");
	if (existsSync(tomlPath)) {
		const toml = readFileSync(tomlPath, "utf8");
		const diffMatch = toml.match(/difficulty\s*=\s*"([^"]+)"/);
		if (diffMatch?.[1]) difficulty = diffMatch[1];
		const catMatch = toml.match(/category\s*=\s*"([^"]+)"/);
		if (catMatch?.[1]) category = catMatch[1];
		const timeoutMatch = toml.match(
			/\[agent\]\s*\n\s*timeout_sec\s*=\s*([\d.]+)/,
		);
		if (timeoutMatch?.[1]) timeoutSec = Number.parseFloat(timeoutMatch[1]);
	}

	return {
		name: taskDir.split(/[/\\]/).pop() ?? "unknown",
		instruction,
		difficulty,
		category,
		timeoutSec,
	};
}

function listTasks(): TaskMeta[] {
	if (!existsSync(TASKS_DIR)) return [];
	return readdirSync(TASKS_DIR)
		.filter((d) => existsSync(resolve(TASKS_DIR, d, "instruction.md")))
		.map((d) => loadTask(resolve(TASKS_DIR, d)));
}

// ── Workspace 准备 ──

function prepareWorkspace(task: TaskMeta): string {
	const wsDir = resolve(WORKSPACES_DIR, task.name);
	// 清理旧的
	if (existsSync(wsDir)) rmSync(wsDir, { recursive: true, force: true });
	mkdirSync(wsDir, { recursive: true });

	// 如果 task 有 environment/workspace 目录，复制初始文件
	const envWs = resolve(TASKS_DIR, task.name, "environment", "workspace");
	if (existsSync(envWs)) {
		cpSync(envWs, wsDir, { recursive: true });
	}

	return wsDir;
}

// ── 单个 Trial 运行 ──

async function runTrial(task: TaskMeta): Promise<HeadlessResult> {
	const workspace = prepareWorkspace(task);
	const paths = resolveBasePaths(workspace);
	ensureDirs(paths);

	console.error(`\n${"─".repeat(60)}`);
	console.error(`▶ Task: ${task.name}`);
	console.error(`  Difficulty: ${task.difficulty} | Category: ${task.category}`);
	console.error(`  Timeout: ${task.timeoutSec}s`);
	console.error(`  Workspace: ${workspace}`);
	console.error(`  Instruction: ${task.instruction.slice(0, 120)}...`);
	console.error("─".repeat(60));

	const result = await runHeadless({
		instruction: task.instruction,
		paths,
		maxIterations: 80,
		timeoutMs: timeoutOverride ?? Math.min(task.timeoutSec * 1000, 1_800_000),
		systemPromptPrefix: [
			"## Harbor Evaluation Context",
			"",
			"You are being evaluated on a coding benchmark task.",
			"The task workspace has been set up for you.",
			"Complete the task autonomously — no human interaction available.",
			"Focus on correctness. Read the instruction carefully.",
		].join("\n"),
	});

	return result;
}

// ── 结果保存 ──

function saveResult(task: TaskMeta, result: HeadlessResult): void {
	mkdirSync(RESULTS_DIR, { recursive: true });
	const resultPath = resolve(RESULTS_DIR, `${task.name}.json`);
	writeFileSync(
		resultPath,
		JSON.stringify(
			{
				task: {
					name: task.name,
					difficulty: task.difficulty,
					category: task.category,
				},
				result: {
					success: result.success,
					submitResult: result.result,
					report: result.report,
					rounds: result.rounds,
					durationMs: result.durationMs,
					error: result.error,
				},
				timestamp: new Date().toISOString(),
			},
			null,
			2,
		),
	);
	console.error(`  📄 Result saved: ${resultPath}`);
}

// ── Main ──

const timeoutOverride = (() => {
	const idx = process.argv.indexOf("--timeout");
	return idx >= 0 ? Number(process.argv[idx + 1]) * 60_000 : null;
})();

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	// 初始化运行时
	const runtime = createRuntimeContext();
	initRuntime(runtime);

	if (args.includes("--list")) {
		const tasks = listTasks();
		console.log(`\nAvailable tasks (${tasks.length}):\n`);
		for (const t of tasks) {
			console.log(
				`  ${t.name.padEnd(40)} ${t.difficulty.padEnd(20)} ${t.category}`,
			);
		}
		return;
	}

	const taskFilter = args.find((a, i) => args[i - 1] === "--task");
	const tasks = listTasks();

	if (tasks.length === 0) {
		console.error("No tasks found in", TASKS_DIR);
		process.exit(1);
	}

	const selectedTasks = taskFilter
		? tasks.filter((t) => t.name.includes(taskFilter))
		: tasks;

	if (selectedTasks.length === 0) {
		console.error(`No tasks matching "${taskFilter}"`);
		process.exit(1);
	}

	console.error(`\n🚀 Harbor Simulation Runner`);
	console.error(`   Tasks: ${selectedTasks.length}`);
	console.error(`   Results: ${RESULTS_DIR}\n`);

	const summary: Array<{
		name: string;
		success: boolean;
		durationMs: number;
		rounds: number;
		error: string | null;
	}> = [];

	for (const task of selectedTasks) {
		try {
			const result = await runTrial(task);
			saveResult(task, result);

			const status = result.success ? "✅" : "❌";
			console.error(
				`\n  ${status} ${task.name} — ${result.rounds} iters, ${(result.durationMs / 1000).toFixed(1)}s`,
			);
			if (result.error) console.error(`     Error: ${result.error}`);
			if (result.result?.type === "completed") {
				console.error(`     Summary: ${result.result.summary}`);
			}

			summary.push({
				name: task.name,
				success: result.success,
				durationMs: result.durationMs,
				rounds: result.rounds,
				error: result.error,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`\n  💥 ${task.name} — Fatal: ${msg}`);
			summary.push({
				name: task.name,
				success: false,
				durationMs: 0,
				rounds: 0,
				error: msg,
			});
		}
	}

	// 汇总
	console.error(`\n${"═".repeat(60)}`);
	console.error("📊 Summary");
	console.error("═".repeat(60));
	const passed = summary.filter((s) => s.success).length;
	console.error(`  Pass: ${passed}/${summary.length}`);
	for (const s of summary) {
		const icon = s.success ? "✅" : "❌";
		console.error(
			`  ${icon} ${s.name.padEnd(40)} ${(s.durationMs / 1000).toFixed(1)}s  ${s.rounds} iters`,
		);
	}

	// 输出 JSON 到 stdout
	console.log(JSON.stringify({ summary, timestamp: new Date().toISOString() }, null, 2));
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
