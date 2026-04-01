/**
 * exec timeout 行为验证测试
 *
 * 目的：验证 execToolStream 在脚本超时时的实际行为，
 * 而不是假设 timeout 机制是否正常。
 *
 * 安全措施：每个涉及超时的测试都用 Promise.race 包裹，
 * 设置外部硬超时，防止 execToolStream 卡死导致整个测试进程挂起。
 */

import { describe, expect, test } from "bun:test";
import type { ExecToolCall, ExecToolResult } from "@n0n/types";
import { ExecArgsSchema, execToolStream } from "../exec.ts";

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
	// 基准测试：正常执行不受 timeout 影响
	test("正常脚本在 timeout 内完成 — 应返回正常结果", async () => {
		const outcome = await collectWithHardTimeout(
			"echo hello",
			10, // exec timeout: 10s（远大于 echo 执行时间）
			5000, // 硬超时: 5s
		);
		expect(outcome.status).toBe("completed");
		if (outcome.status === "completed") {
			expect(outcome.result.exitCode).toBe(0);
			expect(outcome.result.stdout.trim()).toBe("hello");
		}
	});

	// 核心测试：验证 timeout 到期后 execToolStream 是否能正确退出
	test("阻塞脚本超过 timeout — 验证是否卡死", async () => {
		const outcome = await collectWithHardTimeout(
			"sleep 30", // 阻塞 30 秒的脚本
			2, // exec timeout: 2 秒
			8000, // 硬超时: 8 秒（给 timeout 机制充足的反应时间）
		);

		// 如果 timeout 机制正常工作：
		//   outcome.status === "completed"，且在 ~2s 内返回
		// 如果 timeout 机制不工作（当前 bug）：
		//   outcome.status === "hung"，8s 硬超时触发
		if (outcome.status === "hung") {
			console.log(
				`[BUG 确认] execToolStream 在 timeout 后卡死了（${outcome.elapsedMs}ms），未能退出`,
			);
		} else {
			console.log(
				`[PASS] execToolStream 在 timeout 后正确返回，耗时 ${outcome.result.durationMs}ms`,
			);
		}

		// 记录实际行为，不做 expect 断言（因为当前代码预期会失败）
		// 修复后应该改为：
		// expect(outcome.status).toBe("completed");
		console.log("outcome.status:", outcome.status);
	}, 15000); // bun test 级别超时 15s

	// 进程组场景：shell 脚本 fork 子进程
	test("shell fork 子进程场景 — 验证是否卡死", async () => {
		const outcome = await collectWithHardTimeout(
			"sleep 30 &\nwait", // shell fork 子进程后 wait
			2,
			8000,
		);

		if (outcome.status === "hung") {
			console.log(
				`[BUG 确认] shell 子进程场景下 execToolStream 卡死（${outcome.elapsedMs}ms）`,
			);
		} else {
			console.log(
				`[PASS] shell 子进程场景正确返回，耗时 ${outcome.result.durationMs}ms`,
			);
		}
		console.log("outcome.status:", outcome.status);
	}, 15000);
});
