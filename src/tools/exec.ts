/**
 * exec 工具 — 执行 shell 命令
 */

import type { ExecToolResult } from "../types/domain.ts";

interface ExecArgs {
	command: string;
	cwd?: string;
	timeout?: number;
}

const PROJECT_ROOT = process.cwd();

export async function execTool(
	callId: string,
	args: ExecArgs,
): Promise<ExecToolResult> {
	const cwd = args.cwd ?? PROJECT_ROOT;
	const timeoutMs = (args.timeout ?? 120) * 1000;
	const start = Date.now();

	try {
		const proc = Bun.spawn(["sh", "-c", args.command], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});

		// 超时处理
		const timer = setTimeout(() => {
			proc.kill();
		}, timeoutMs);

		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		const exitCode = await proc.exited;
		clearTimeout(timer);

		const durationMs = Date.now() - start;

		// 实时输出到控制台，让用户可见
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);

		// 截断过长输出
		const maxLen = 30_000;
		const truncate = (s: string) =>
			s.length > maxLen
				? `${s.slice(0, maxLen)}\n... [truncated, ${s.length} chars total]`
				: s;

		return {
			type: "tool_result",
			callId,
			tool: "exec",
			command: args.command,
			cwd,
			exitCode,
			stdout: truncate(stdout),
			stderr: truncate(stderr),
			durationMs,
		};
	} catch (err) {
		return {
			type: "tool_result",
			callId,
			tool: "exec",
			command: args.command,
			cwd,
			exitCode: 1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - start,
		};
	}
}
