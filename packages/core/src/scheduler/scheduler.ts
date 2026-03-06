/**
 * 定时触发器 — MDC 文件驱动
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";
import { paths } from "../config.ts";
import { delegateTask } from "../task/delegate.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { runWorkflow } from "../workflow/runtime.ts";
import { cronMatches, parseCron } from "./cron.ts";

const SCHEDULES_DIR = paths.schedules;

export interface ScheduleEntry {
	name: string;
	cron: string;
	enabled: boolean;
	workflow: string | null;
	prompt: string;
	filePath: string;
}

export async function loadSchedules(): Promise<ScheduleEntry[]> {
	const dir = resolve(SCHEDULES_DIR);
	if (!existsSync(dir)) return [];

	const glob = new Glob("**/*.mdc");
	const files = Array.from(glob.scanSync({ cwd: dir, absolute: true }));

	const entries: ScheduleEntry[] = [];

	for (const file of files) {
		try {
			const content = await Bun.file(file).text();
			const { meta, body } = parseFrontmatter(content);

			if (!meta.name || !meta.cron) continue;

			entries.push({
				name: meta.name,
				cron: meta.cron,
				enabled: meta.enabled !== "false",
				workflow: meta.workflow || null,
				prompt: body,
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
): Promise<ScheduleEntry | null> {
	const entries = await loadSchedules();
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

	if (updated === original) {
		throw new Error(
			`Failed to update schedule frontmatter: ${target.filePath}`,
		);
	}

	await Bun.write(target.filePath, updated);

	return { ...target, enabled };
}

// ── 触发循环 ──

let running = false;

export async function startScheduler(): Promise<void> {
	if (running) return;
	running = true;

	console.log(
		`[scheduler] Started. Watching ${SCHEDULES_DIR}/*.mdc every 60s.`,
	);

	const tick = async () => {
		if (!running) return;

		const now = new Date();
		const entries = await loadSchedules();

		for (const entry of entries) {
			if (!entry.enabled) continue;

			try {
				const fields = parseCron(entry.cron);
				if (!cronMatches(fields, now)) continue;

				console.log(`[scheduler] Triggering: ${entry.name}`);

				if (entry.workflow) {
					runWorkflow(entry.workflow).then(
						(result) => {
							console.log(
								`[scheduler] ✅ ${entry.name}:`,
								typeof result === "string" ? result.slice(0, 200) : result,
							);
						},
						(err) => {
							console.error(`[scheduler] ❌ ${entry.name}:`, err);
						},
					);
				} else {
					delegateTask(entry.prompt).then(
						(result) => {
							console.log(
								`[scheduler] ✅ ${entry.name}:`,
								result.report ?? result.result,
							);
						},
						(err) => {
							console.error(`[scheduler] ❌ ${entry.name}:`, err);
						},
					);
				}
			} catch (err) {
				console.error(`[scheduler] Error: ${entry.name}:`, err);
			}
		}
	};

	const interval = setInterval(tick, 60_000);
	await tick();

	process.on("SIGINT", () => {
		running = false;
		clearInterval(interval);
		console.log("[scheduler] Stopped.");
	});
}

export function stopScheduler(): void {
	running = false;
}
