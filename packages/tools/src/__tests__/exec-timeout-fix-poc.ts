/**
 * exec timeout 修复方案 PoC 验证
 *
 * 独立脚本，不依赖项目任何模块。
 * 用 Bun 原生 API 模拟 execToolStream 的核心流程，
 * 验证 Promise.race 方案能否在超时后正确中断流读取并转入后台。
 *
 * 运行: bun run packages/tools/src/__tests__/exec-timeout-fix-poc.ts
 */

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEMP_DIR = ".temp";
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

// ── 模拟修复后的核心逻辑 ──

interface TimeoutResult {
	timedOut: true;
	pid: number;
	logFile: string;
	stdoutSoFar: string;
	stderrSoFar: string;
	durationMs: number;
}

interface CompletedResult {
	timedOut: false;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}

type ExecResult = TimeoutResult | CompletedResult;

async function execWithFixedTimeout(
	cmd: string[],
	timeoutSec: number,
): Promise<ExecResult> {
	const start = Date.now();
	const timeoutMs = timeoutSec * 1000;

	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
	});

	const pid = proc.pid;
	console.log(`  [spawn] PID=${pid}, timeout=${timeoutSec}s`);

	// ── 流读取 ──
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const decoder = new TextDecoder();

	let streamsDone = 0;
	let notify: (() => void) | null = null;

	const pumpStream = async (
		stream: ReadableStream<Uint8Array>,
		bucket: string[],
	) => {
		const reader = stream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				bucket.push(decoder.decode(value, { stream: true }));
				notify?.();
			}
		} finally {
			reader.releaseLock();
			streamsDone++;
			notify?.();
		}
	};

	pumpStream(proc.stdout!, stdoutChunks);
	pumpStream(proc.stderr!, stderrChunks);

	// ── 修复核心：Promise.race 实现确定性超时中断 ──
	let timedOut = false;
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		setTimeout(() => {
			timedOut = true;
			resolve("timeout");
		}, timeoutMs);
	});

	// 模拟流读取主循环 + 超时竞争
	while (streamsDone < 2) {
		if (timedOut) break;

		const waitForData = new Promise<"data">((r) => {
			notify = () => r("data");
		});
		const raceResult = await Promise.race([waitForData, timeoutPromise]);
		notify = null;
		if (raceResult === "timeout") break;
	}

	const durationMs = Date.now() - start;

	if (timedOut) {
		// ── 超时路径：写日志，后台继续收集 ──
		const logFile = join(TEMP_DIR, `exec_bg_${pid}_${Date.now()}.log`);
		const stdoutSoFar = stdoutChunks.join("");
		const stderrSoFar = stderrChunks.join("");

		// 写入已收集的输出
		await Bun.write(logFile, `--- stdout so far ---\n${stdoutSoFar}\n--- stderr so far ---\n${stderrSoFar}\n--- background continues ---\n`);

		// 启动后台协程继续收集
		(async () => {
			const file = Bun.file(logFile);
			// 继续读取直到流关闭
			while (streamsDone < 2) {
				await new Promise<void>((r) => { notify = () => r(); });
				notify = null;
			}
			// 进程退出
			const exitCode = await proc.exited;
			const finalStdout = stdoutChunks.join("");
			const finalStderr = stderrChunks.join("");
			const finalContent = `--- stdout (complete) ---\n${finalStdout}\n--- stderr (complete) ---\n${finalStderr}\n--- Process exited with code ${exitCode} ---\n`;
			await Bun.write(logFile, finalContent);
			console.log(`  [background] PID=${pid} exited (code=${exitCode}), log updated: ${logFile}`);
		})();

		return { timedOut: true, pid, logFile, stdoutSoFar, stderrSoFar, durationMs };
	}

	// ── 正常完成路径 ──
	const exitCode = await proc.exited;
	return {
		timedOut: false,
		exitCode,
		stdout: stdoutChunks.join(""),
		stderr: stderrChunks.join(""),
		durationMs,
	};
}

// ── 测试用例 ──

async function test(name: string, fn: () => Promise<void>) {
	console.log(`\n▶ ${name}`);
	try {
		await fn();
		console.log(`  ✅ PASS`);
	} catch (e) {
		console.log(`  ❌ FAIL: ${e}`);
	}
}

const assert = (condition: boolean, msg: string) => {
	if (!condition) throw new Error(msg);
};

await test("正常脚本 — 应在 timeout 内正常完成", async () => {
	const result = await execWithFixedTimeout(["sh", "-c", "echo hello"], 5);
	assert(!result.timedOut, `不应超时，实际: timedOut=${result.timedOut}`);
	if (!result.timedOut) {
		assert(result.exitCode === 0, `exitCode 应为 0，实际: ${result.exitCode}`);
		assert(result.stdout.trim() === "hello", `stdout 应为 hello，实际: ${result.stdout.trim()}`);
	}
	console.log(`  耗时: ${result.durationMs}ms`);
});

await test("阻塞脚本 sleep 30 + timeout=2 — 应超时并返回", async () => {
	const start = Date.now();
	const result = await execWithFixedTimeout(["sh", "-c", "sleep 30"], 2);
	const elapsed = Date.now() - start;

	assert(result.timedOut === true, `应超时，实际: timedOut=${result.timedOut}`);
	assert(elapsed < 5000, `应在 ~2s 返回，实际: ${elapsed}ms`);

	if (result.timedOut) {
		console.log(`  PID: ${result.pid}`);
		console.log(`  logFile: ${result.logFile}`);
		console.log(`  耗时: ${result.durationMs}ms (外部: ${elapsed}ms)`);

		// 验证日志文件已创建
		const logExists = existsSync(result.logFile);
		assert(logExists, `日志文件应存在: ${result.logFile}`);
		console.log(`  日志文件存在: ${logExists}`);

		// kill 后台进程以清理
		try { process.kill(result.pid, "SIGKILL"); } catch {}
	}
});

await test("shell fork 子进程 + timeout=2 — 应超时并返回", async () => {
	const start = Date.now();
	const result = await execWithFixedTimeout(
		["sh", "-c", "echo partial_output && sleep 30"],
		2,
	);
	const elapsed = Date.now() - start;

	assert(result.timedOut === true, `应超时，实际: timedOut=${result.timedOut}`);
	assert(elapsed < 5000, `应在 ~2s 返回，实际: ${elapsed}ms`);

	if (result.timedOut) {
		assert(
			result.stdoutSoFar.includes("partial_output"),
			`stdoutSoFar 应包含 partial_output，实际: "${result.stdoutSoFar.trim()}"`,
		);
		console.log(`  PID: ${result.pid}`);
		console.log(`  stdoutSoFar: "${result.stdoutSoFar.trim()}"`);
		console.log(`  耗时: ${result.durationMs}ms (外部: ${elapsed}ms)`);

		try { process.kill(result.pid, "SIGKILL"); } catch {}
	}
});

await test("有持续输出的脚本 + timeout=2 — 应捕获超时前输出", async () => {
	const start = Date.now();
	// 每 0.5s 输出一行，持续 10s
	const result = await execWithFixedTimeout(
		["sh", "-c", "for i in 1 2 3 4 5 6 7 8 9 10; do echo line_$i; sleep 0.5; done"],
		2,
	);
	const elapsed = Date.now() - start;

	assert(result.timedOut === true, `应超时`);
	assert(elapsed < 5000, `应在 ~2s 返回，实际: ${elapsed}ms`);

	if (result.timedOut) {
		const lines = result.stdoutSoFar.trim().split("\n").filter(Boolean);
		console.log(`  捕获到 ${lines.length} 行输出: ${lines.join(", ")}`);
		assert(lines.length >= 2, `应至少捕获 2 行，实际: ${lines.length}`);
		assert(lines.length <= 5, `不应超过 5 行（2s 内），实际: ${lines.length}`);
		console.log(`  耗时: ${result.durationMs}ms`);

		try { process.kill(result.pid, "SIGKILL"); } catch {}
	}
});

// 等一小会让后台协程打印日志
await new Promise((r) => setTimeout(r, 1000));
console.log("\n🏁 所有测试完成");
process.exit(0);
