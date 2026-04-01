/**
 * exec timeout 行为验证测试
 *
 * 验证 execToolStream 在脚本超时后能正确返回 timedOut 结果，
 * 而不是卡死。使用 Promise.race 硬超时保护防止测试进程挂起。
 */

import { describe, expect, test } from "bun:test";
import type { ExecToolCall, ExecToolResult } from "@n0n/types";
import { ExecArgsSchema, execToolStream } from "../exec/index.ts";

/** 收集 exec 流式输出，带硬超时保护 */
async function collectWithHardTimeout(
	script: string,
	execTimeout: number,
	hardTimeoutMs: number,
	runtime?: string,
): Promise<
	| { status: "completed"; result: ExecToolResult }
	| { status: "hung"; elapsedMs: number }
> {
	const args = ExecArgsSchema.parse({ script, runtime, timeout: execTimeout });
	const call: ExecToolCall = { id: "timeout-test", tool: "exec", args };
	const start = Date.now();

	const execPromise = (async () => {
		for await (const event of execToolStream(call, undefined, {
			workspace: process.cwd(),
			tempDir: ".temp",
			blockedCommands: [],
			defaultExecTimeout: execTimeout,
		})) {
			if (event.type === "tool_result" && event.tool === "exec") {
				return { status: "completed" as const, result: event };
			}
		}
		throw new Error("No tool_result yielded");
	})();

	const hardTimeout = new Promise<{ status: "hung"; elapsedMs: number }>(
		(resolve) => {
			setTimeout(() => {
				resolve({ status: "hung", elapsedMs: Date.now() - start });
			}, hardTimeoutMs);
		},
	);

	return Promise.race([execPromise, hardTimeout]);
}

describe("exec timeout 行为验证", () => {
	test("正常脚本在 timeout 内完成 — 应返回正常结果", async () => {
		const outcome = await collectWithHardTimeout("echo hello", 10, 5000);
		expect(outcome.status).toBe("completed");
		if (outcome.status === "completed" && !outcome.result.timedOut) {
			expect(outcome.result.exitCode).toBe(0);
			expect(outcome.result.stdout.trim()).toBe("hello");
		}
	});

	test("阻塞脚本超过 timeout — 应返回 timedOut 结果而非卡死", async () => {
		const outcome = await collectWithHardTimeout("sleep 30", 2, 8000);

		// 修复后应正确返回，不再卡死
		expect(outcome.status).toBe("completed");
		if (outcome.status === "completed") {
			expect(outcome.result.timedOut).toBe(true);
			if (outcome.result.timedOut) {
				expect(outcome.result.pid).toBeGreaterThan(0);
				expect(outcome.result.logFile).toContain("exec_bg_");
				// 超时后 kill 后台进程以清理
				try {
					process.kill(outcome.result.pid, "SIGKILL");
				} catch {}
			}
		}
	}, 15000);

	test("shell fork 子进程场景 — 应返回 timedOut 结果而非卡死", async () => {
		const outcome = await collectWithHardTimeout("sleep 30 &\nwait", 2, 8000);

		expect(outcome.status).toBe("completed");
		if (outcome.status === "completed") {
			expect(outcome.result.timedOut).toBe(true);
			if (outcome.result.timedOut) {
				try {
					process.kill(outcome.result.pid, "SIGKILL");
				} catch {}
			}
		}
	}, 15000);

	test("有持续输出的脚本超时 — 应捕获超时前的部分输出", async () => {
		const outcome = await collectWithHardTimeout(
			"for i in 1 2 3 4 5 6 7 8 9 10; do echo line_$i; sleep 0.5; done",
			2,
			8000,
		);

		expect(outcome.status).toBe("completed");
		if (outcome.status === "completed") {
			expect(outcome.result.timedOut).toBe(true);
			if (outcome.result.timedOut) {
				const lines = outcome.result.stdoutSoFar
					.trim()
					.split("\n")
					.filter(Boolean);
				expect(lines.length).toBeGreaterThanOrEqual(2);
				expect(lines.length).toBeLessThanOrEqual(5);
				try {
					process.kill(outcome.result.pid, "SIGKILL");
				} catch {}
			}
		}
	}, 15000);
});
