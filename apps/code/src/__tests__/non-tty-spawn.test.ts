/**
 * 非 TTY 环境启动测试
 *
 * 验证：通过管道（exec/spawn）调用 n0n 时，不会因 setRawMode 不存在而 crash。
 * 这是一个集成测试 — 实际 spawn 子进程，stdin 为管道（非 TTY）。
 *
 * 验收条件：
 * 1. 进程不因 TypeError: process.stdin.setRawMode is not a function 退出
 * 2. stderr 中出现正常的初始化日志（如 "配置检查通过" 或 "LLM 连接"）
 *    或者因 LLM 连接失败而退出（这也是合法的 — 说明已经过了 setRawMode 阶段）
 * 3. 如果 LLM 可用，进程最终应正常退出（exit 0）
 */

import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const CLI_PATH = resolve(__dirname, "../cli.ts");
const WORKSPACE = resolve(__dirname, "../../../.."); // 项目根目录

/**
 * 辅助：spawn n0n 子进程，stdin 为管道（模拟 exec 环境），收集 stdout/stderr
 */
function spawnN0n(
	args: string[],
	options: { timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const { timeoutMs = 30_000 } = options;

	return new Promise((resolve, reject) => {
		const proc = spawn("bun", [CLI_PATH, ...args], {
			cwd: WORKSPACE,
			stdio: ["pipe", "pipe", "pipe"], // stdin/stdout/stderr 全部为管道 → 非 TTY
			env: { ...process.env },
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		// 立即关闭 stdin，模拟没有输入的场景
		proc.stdin?.end();

		const timer = setTimeout(() => {
			proc.kill();
			// 超时也算"通过了 setRawMode 阶段"
			resolve({ exitCode: -1, stdout, stderr });
		}, timeoutMs);

		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

describe("非 TTY 环境启动", () => {
	test("不因 setRawMode 崩溃", async () => {
		const result = await spawnN0n(
			["请你使用submit提交下面的答案：1+1=？"],
			{ timeoutMs: 15_000 },
		);

		// 核心断言：不应该出现 setRawMode 错误
		expect(result.stderr).not.toContain("setRawMode is not a function");
		expect(result.stderr).not.toContain(
			"process.stdin.setRawMode is not a function",
		);

		// 辅助断言：应该能看到初始化过程的输出（说明 bootstrap 阶段正常）
		// 如果 LLM 连接失败，至少也应该看到配置检查的日志
		const passedBootstrap =
			result.stderr.includes("配置检查通过") ||
			result.stderr.includes("初始化完成") ||
			result.stderr.includes("LLM 连接") ||
			result.stderr.includes("Code Agent");

		expect(passedBootstrap).toBe(true);

		// exitCode === -1 表示超时被 kill（agent 还在运行 LLM 调用）— 也算通过
		// exitCode === 0 表示正常退出
		// exitCode === 1 且无 setRawMode 错误 — 可能是其他问题，上面已断言通过
	}, 20_000);

	test("--help 在非 TTY 下正常工作（基线）", async () => {
		const result = await spawnN0n(["--help"], { timeoutMs: 5_000 });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("n0n");
		expect(result.stderr).not.toContain("setRawMode");
	});
});
