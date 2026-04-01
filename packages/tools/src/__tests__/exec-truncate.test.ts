/**
 * exec 输出截断行为验证测试
 *
 * 验证 execToolStream 在输出超过阈值时：
 * - 返回 status: "truncated"
 * - stdoutTail 包含末尾内容
 * - outputFile 已创建且包含完整输出
 * - 短输出仍返回 status: "completed"
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { ExecToolCall } from "@n0n/types";
import { ExecArgsSchema, execToolStream } from "../exec/index.ts";

/** 收集 exec 结果 */
async function collectResult(script: string, runtime?: string) {
	const args = ExecArgsSchema.parse({ script, runtime });
	const call: ExecToolCall = { id: "trunc-test", tool: "exec", args };

	for await (const event of execToolStream(call, undefined, {
		workspace: process.cwd(),
		tempDir: ".temp",
		blockedCommands: [],
		defaultExecTimeout: 120,
	})) {
		if (event.type === "tool_result" && event.tool === "exec") {
			return event;
		}
	}
	throw new Error("No tool_result yielded");
}

describe("exec 输出截断", () => {
	test("短输出 — 应返回 status: completed", async () => {
		const result = await collectResult("echo hello");
		expect(result.status).toBe("completed");
		if (result.status === "completed") {
			expect(result.stdout.trim()).toBe("hello");
		}
	});

	test("超长输出 — 应返回 status: truncated + outputFile", async () => {
		// 生成超过 8000 字符的输出
		const script = `for i in $(seq 1 500); do echo "line_$i: $(printf '%0.s=' $(seq 1 20))"; done`;
		const result = await collectResult(script);

		expect(result.status).toBe("truncated");
		if (result.status === "truncated") {
			// stdoutTail 应包含末尾内容
			expect(result.stdoutTail).toContain("line_500");
			expect(result.stdoutTail.length).toBeLessThanOrEqual(2100); // ~TAIL_LENGTH + 小余量

			// outputFile 应存在
			expect(existsSync(result.outputFile)).toBe(true);

			// 长度信息应正确
			expect(result.stdoutLength).toBeGreaterThan(8000);
			expect(result.exitCode).toBe(0);
		}
	});

	test("超长 stderr — 应返回 status: truncated", async () => {
		// 向 stderr 输出大量内容
		const script = `for i in $(seq 1 500); do echo "err_$i: $(printf '%0.s=' $(seq 1 20))" >&2; done`;
		const result = await collectResult(script);

		expect(result.status).toBe("truncated");
		if (result.status === "truncated") {
			expect(result.stderrTail).toContain("err_500");
			expect(result.stderrLength).toBeGreaterThan(8000);
		}
	});

	test("恰好在阈值内 — 应返回 status: completed", async () => {
		// 生成刚好不超过阈值的输出（~100 行 × 30 字符 ≈ 3000）
		const script = `for i in $(seq 1 100); do echo "short_line_$i_padding"; done`;
		const result = await collectResult(script);

		expect(result.status).toBe("completed");
		if (result.status === "completed") {
			expect(result.stdout).toContain("short_line_100");
		}
	});
});
