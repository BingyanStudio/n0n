/**
 * 生成 exec 后台日志文件的真实预览样例
 *
 * 直接复用 executor.ts 中 buildLogContent 的逻辑，
 * 确保预览与运行时产物完全一致。
 *
 * 运行: bun run packages/tools/scripts/preview-exec-bg-files.ts
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";


const PREVIEW_DIR = join(import.meta.dir, "preview-output");
mkdirSync(PREVIEW_DIR, { recursive: true });

// ── 从 executor.ts 复制 buildLogContent 的核心逻辑 ──
// 不做抽取——保持与源码同步，避免过早抽象。
// 如果 executor.ts 中的格式发生变化，重新运行此脚本即可。

function buildLogContent(
	pid: number,
	startedAt: string,
	opts: {
		status: "running" | "exited";
		stdout: string;
		stderr: string;
		exitCode?: number;
		endedAt?: string;
		totalDurationMs?: number;
	},
): string {
	const now = opts.endedAt ?? new Date().toISOString();
	const stdoutSection = `--- stdout ---\n${opts.stdout || "(empty)"}`;
	const stderrSection = `--- stderr ---\n${opts.stderr || "(empty)"}`;

	const metaLines = [`pid: ${pid}`, `status: ${opts.status}`, `started_at: ${startedAt}`];

	if (opts.status === "running") {
		metaLines.push(`last_updated: ${now}`);
		metaLines.push(
			`note: If current time is far ahead of last_updated, log sync may be delayed — verify process status via PID. If current time is close to last_updated and content unchanged, the process likely has no new output.`,
		);
	} else {
		if (opts.exitCode !== undefined) metaLines.push(`exit_code: ${opts.exitCode}`);
		if (opts.endedAt) metaLines.push(`ended_at: ${opts.endedAt}`);
		if (opts.totalDurationMs !== undefined) {
			const secs = Math.round(opts.totalDurationMs / 1000);
			const mins = Math.floor(secs / 60);
			const remSecs = secs % 60;
			const human = mins > 0 ? `${mins}m ${remSecs}s` : `${secs}s`;
			metaLines.push(`duration: ${opts.totalDurationMs}ms (${human})`);
		}

		metaLines.push(`last_updated: ${now}`);
	}

	return `${stdoutSection}\n${stderrSection}\n--- exec_bg_meta ---\n${metaLines.join("\n")}\n---\n`;
}

// ── 生成样例 ──

const PID = 29184;
const STARTED = "2025-07-17T14:30:00.000Z";

const files: { name: string; content: string }[] = [];

// 1. running — 进程刚转入后台，有少量输出
files.push({
	name: "exec_bg_running.log",
	content: buildLogContent(PID, STARTED, {
		status: "running",
		stdout: "Starting dev server...\nListening on http://localhost:3000\n",
		stderr: "",
	}),
});

// 2. running — 进程运行中，无输出（体现心跳更新）
files.push({
	name: "exec_bg_running_no_output.log",
	content: buildLogContent(PID, STARTED, {
		status: "running",
		stdout: "",
		stderr: "",
	}),
});

// 3. running — 进程运行中，有 stderr
files.push({
	name: "exec_bg_running_with_stderr.log",
	content: buildLogContent(PID, STARTED, {
		status: "running",
		stdout: "Compiling...\n",
		stderr: "Warning: unused variable 'x' at src/main.ts:12\n",
	}),
});

// 4. exited — 正常退出
files.push({
	name: "exec_bg_exited.log",
	content: buildLogContent(PID, STARTED, {
		status: "exited",
		stdout: "Starting dev server...\nListening on http://localhost:3000\nBuild completed in 2.3s\nServer shutting down...\n",
		stderr: "",
		exitCode: 0,
		endedAt: "2025-07-17T14:32:30.000Z",
		totalDurationMs: 150000,
	}),
});

// 5. exited — 非零退出码
files.push({
	name: "exec_bg_exited_error.log",
	content: buildLogContent(PID, STARTED, {
		status: "exited",
		stdout: "Running tests...\n3 passed, 1 failed\n",
		stderr: "AssertionError: expected 42 but got 0\n  at test/math.test.ts:15:3\n",
		exitCode: 1,
		endedAt: "2025-07-17T14:30:08.000Z",
		totalDurationMs: 8000,
	}),
});

// ── 写入文件 ──

for (const f of files) {
	const outPath = join(PREVIEW_DIR, f.name);
	await Bun.write(outPath, f.content);
	console.log(`  ${f.name}`);
}

console.log(`\nGenerated ${files.length} preview files in ${PREVIEW_DIR}/`);
