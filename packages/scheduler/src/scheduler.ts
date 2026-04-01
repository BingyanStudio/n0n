/**
 * 定时触发器 — MDC 文件驱动
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrontmatter } from "@n0n/shared";
import { delegateTask, runWorkflow, type WorkflowPaths } from "@n0n/workflow";
import { Glob } from "bun";
import { z } from "zod";
import { cronMatches, parseCron } from "./cron.ts";

export type SchedulePaths = Pick<WorkflowPaths, "schedules">;
export type SchedulerPaths = WorkflowPaths;

export interface ScheduleEntry {
	name: string;
	cron: string;
	enabled: boolean;
	workflow: string | null;
	prompt: string;
	filePath: string;
}

/** Schedule frontmatter 的 Zod schema — 解析时自动校验必填字段和类型转换 */
const ScheduleFrontmatterSchema = z.object({
	name: z.string(),
	cron: z.string(),
	enabled: z.preprocess((v) => v !== "false", z.boolean()),
	workflow: z.string().optional(),
});

export async function loadSchedules(
	paths: SchedulePaths,
): Promise<ScheduleEntry[]> {
	const dir = resolve(paths.schedules);
	if (!existsSync(dir)) return [];

	const glob = new Glob("**/*.mdc");
	const files = Array.from(glob.scanSync({ cwd: dir, absolute: true }));

	const entries: ScheduleEntry[] = [];

	for (const file of files) {
		try {
			const content = await Bun.file(file).text();
			const result = parseFrontmatter(content, ScheduleFrontmatterSchema);
			if (!result) continue;

			entries.push({
				name: result.data.name,
				cron: result.data.cron,
				enabled: result.data.enabled,
				workflow: result.data.workflow ?? null,
				prompt: result.body,
				filePath: file,
			});
		} catch {
			// skip
		}
	}

	return entries;
}

export async function setScheduleEnabled(
	name: string,
	enabled: boolean,
	paths: SchedulePaths,
): Promise<ScheduleEntry | null> {
	const entries = await loadSchedules(paths);
	const target = entries.find((entry) => entry.name === name);
	if (!target) return null;

	const original = await Bun.file(target.filePath).text();
	const updated = original.replace(
		/^---\r?\n([\s\S]*?)\r?\n---/,
		(_match, frontmatter: string) => {
			const lines = frontmatter.split(/\r?\n/);
			const idx = lines.findIndex((line) => /^enabled\s*:/.test(line.trim()));
			const enabledLine = `enabled: ${enabled ? "true" : "false"}`;
			if (idx >= 0) {
				lines[idx] = enabledLine;
			} else {
				lines.push(enabledLine);
			}
			return `---\n${lines.join("\n")}\n---`;
		},
	);

	// 已经是目标状态，幂等返回
	if (updated === original) {
		return { ...target, enabled };
	}

	await Bun.write(target.filePath, updated);

	return { ...target, enabled };
}

// ── 触发循环 ──

export interface SchedulerCallbacks {
	onTaskComplete?: (
		entry: ScheduleEntry,
		result: unknown,
	) => void | Promise<void>;
	onTaskError?: (entry: ScheduleEntry, error: unknown) => void | Promise<void>;
}

export interface SchedulerHandle {
	stop(): void;
}

export async function startScheduler(
	paths: SchedulerPaths,
	callbacks?: SchedulerCallbacks,
): Promise<SchedulerHandle> {
	let running = true;

	console.log(
		`[scheduler] Started. Watching ${paths.schedules}/*.mdc every 60s.`,
	);

	/** 正在执行的任务名集合，防止同一任务在执行期间被重复触发 */
	const executing = new Set<string>();

	const tick = async () => {
		if (!running) return;

		const now = new Date();
		const entries = await loadSchedules(paths);

		for (const entry of entries) {
			if (!entry.enabled) continue;
			if (executing.has(entry.name)) {
				console.log(
					`[scheduler] Skipping ${entry.name}: still running from previous trigger`,
				);
				continue;
			}

			try {
				const fields = parseCron(entry.cron);
				if (!cronMatches(fields, now)) continue;

				console.log(`[scheduler] Triggering: ${entry.name}`);

				if (entry.workflow) {
					// workflow 路径基于 workspace 解析
					const workflowPath = resolve(paths.workspace, entry.workflow);
					executing.add(entry.name);
					runWorkflow(workflowPath, undefined, paths.workspace)
						.then(async (result) => {
							console.log(
								`[scheduler] ✅ ${entry.name}:`,
								typeof result === "string" ? result.slice(0, 200) : result,
							);
							await callbacks?.onTaskComplete?.(entry, result);
						})
						.catch(async (err) => {
							console.error(
								`[scheduler] ❌ Workflow failed: ${entry.name}:`,
								err,
							);
							await callbacks?.onTaskError?.(entry, err);
						})
						.finally(() => {
							executing.delete(entry.name);
						});
				} else {
					// 传播 workspace 配置给 delegateTask
					executing.add(entry.name);
					delegateTask(entry.prompt, { paths })
						.then(async (result) => {
							console.log(
								`[scheduler] ✅ ${entry.name}:`,
								result.report ?? result.result,
							);
							await callbacks?.onTaskComplete?.(entry, result);
						})
						.catch(async (err) => {
							console.error(
								`[scheduler] ❌ Delegate task failed: ${entry.name}:`,
								err,
							);
							await callbacks?.onTaskError?.(entry, err);
						})
						.finally(() => {
							executing.delete(entry.name);
						});
				}
			} catch (err) {
				console.error(`[scheduler] Error: ${entry.name}:`, err);
			}
		}
	};

	const interval = setInterval(tick, 60_000);
	await tick();

	return {
		stop() {
			running = false;
			clearInterval(interval);
			console.log(`[scheduler] Stopped (${paths.schedules}).`);
		},
	};
}
