/**
 * 定时触发器 — MDC 文件驱动
 *
 * 监控 workflows/schedules/ 目录下的 .mdc 文件，
 * 按 cron 表达式触发 delegateTask 或 runWorkflow。
 *
 * MDC 格式：
 * ---
 * name: task-name
 * cron: "0 8 * * *"
 * enabled: true
 * workflow: workflows/tasks/xxx.ts  # 可选，有则直接运行 workflow
 * ---
 * 提示词内容（当无 workflow 字段时，作为 delegateTask 的 query）
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { delegateTask } from "../task/delegate.ts";
import { runWorkflow } from "../workflow/runtime.ts";
import { cronMatches, parseCron } from "./cron.ts";

const SCHEDULES_DIR = "workflows/schedules";

export interface ScheduleEntry {
	name: string;
	cron: string;
	enabled: boolean;
	workflow: string | null;
	prompt: string;
	filePath: string;
}

/**
 * 解析 MDC 文件的 frontmatter
 */
function parseMdc(content: string): {
	meta: Record<string, string>;
	body: string;
} {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return { meta: {}, body: content.trim() };

	const meta: Record<string, string> = {};
	for (const line of (match[1] ?? "").split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const val = line
			.slice(colonIdx + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		meta[key] = val;
	}

	return { meta, body: (match[2] ?? "").trim() };
}

/**
 * 扫描 schedules 目录，加载所有 .mdc 文件
 */
export async function loadSchedules(): Promise<ScheduleEntry[]> {
	const dir = resolve(SCHEDULES_DIR);
	if (!existsSync(dir)) return [];

	const proc = Bun.spawnSync(["find", dir, "-name", "*.mdc", "-type", "f"], {
		stdout: "pipe",
	});

	const files = new TextDecoder()
		.decode(proc.stdout)
		.trim()
		.split("\n")
		.filter(Boolean);

	const entries: ScheduleEntry[] = [];

	for (const file of files) {
		try {
			const content = await Bun.file(file).text();
			const { meta, body } = parseMdc(content);

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
			// 解析失败静默跳过
		}
	}

	return entries;
}

// ── 触发循环 ──

let running = false;

export async function startScheduler(): Promise<void> {
	if (running) return;
	running = true;

	console.log(
		"[scheduler] Started. Watching workflows/schedules/*.mdc every 60s.",
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
					// 有 workflow 文件 → 直接运行
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
					// 无 workflow → 用提示词 delegateTask
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

	// 每分钟检查
	const interval = setInterval(tick, 60_000);
	// 立即执行一次
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
