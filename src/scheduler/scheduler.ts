/**
 * 定时触发器 — 持久化调度表 + 触发循环
 *
 * 调度表持久化为 JSON 文件，触发循环每分钟检查一次。
 */

import { existsSync } from "node:fs";
import { delegateTask } from "../task/delegate.ts";
import { cronMatches, parseCron } from "./cron.ts";

const SCHEDULE_FILE = "data/schedules.json";

export interface ScheduleEntry {
	id: string;
	name: string;
	cron: string;
	task: string;
	enabled: boolean;
	createdAt: string;
	lastRunAt: string | null;
}

// ── 调度表管理 ──

async function loadSchedules(): Promise<ScheduleEntry[]> {
	if (!existsSync(SCHEDULE_FILE)) return [];
	try {
		const text = await Bun.file(SCHEDULE_FILE).text();
		return JSON.parse(text) as ScheduleEntry[];
	} catch {
		return [];
	}
}

async function saveSchedules(entries: ScheduleEntry[]): Promise<void> {
	await Bun.write(SCHEDULE_FILE, JSON.stringify(entries, null, 2));
}

export async function addSchedule(
	name: string,
	cron: string,
	task: string,
): Promise<ScheduleEntry> {
	// 验证 cron 表达式
	parseCron(cron);

	const entries = await loadSchedules();
	const entry: ScheduleEntry = {
		id: crypto.randomUUID(),
		name,
		cron,
		task,
		enabled: true,
		createdAt: new Date().toISOString(),
		lastRunAt: null,
	};
	entries.push(entry);
	await saveSchedules(entries);
	return entry;
}

export async function removeSchedule(id: string): Promise<boolean> {
	const entries = await loadSchedules();
	const filtered = entries.filter((e) => e.id !== id);
	if (filtered.length === entries.length) return false;
	await saveSchedules(filtered);
	return true;
}

export async function listSchedules(): Promise<ScheduleEntry[]> {
	return loadSchedules();
}

// ── 触发循环 ──

let running = false;

export async function startScheduler(): Promise<void> {
	if (running) return;
	running = true;

	console.log("[scheduler] Started. Checking every 60s.");

	const tick = async () => {
		if (!running) return;

		const now = new Date();
		const entries = await loadSchedules();

		for (const entry of entries) {
			if (!entry.enabled) continue;

			try {
				const fields = parseCron(entry.cron);
				if (cronMatches(fields, now)) {
					console.log(`[scheduler] Triggering: ${entry.name}`);
					entry.lastRunAt = now.toISOString();

					// 异步执行，不阻塞调度循环
					delegateTask(entry.task, { skipConsultation: false }).then(
						(result) => {
							console.log(
								`[scheduler] Completed: ${entry.name}`,
								result.report,
							);
						},
						(err) => {
							console.error(`[scheduler] Failed: ${entry.name}`, err);
						},
					);
				}
			} catch (err) {
				console.error(`[scheduler] Error checking ${entry.name}:`, err);
			}
		}

		await saveSchedules(entries);
	};

	// 每分钟检查
	const interval = setInterval(tick, 60_000);
	// 立即执行一次
	await tick();

	// 优雅退出
	process.on("SIGINT", () => {
		running = false;
		clearInterval(interval);
		console.log("[scheduler] Stopped.");
	});
}

export function stopScheduler(): void {
	running = false;
}
