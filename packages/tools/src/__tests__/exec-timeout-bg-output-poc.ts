/**
 * 验证：超时后进程在后台继续执行，后续输出能否被记录到日志文件
 *
 * 场景：脚本每 0.5s 输出一行，共 8 行（4s 完成），timeout=2s
 * 预期：超时时捕获约 4 行 → 后台继续 → 等进程结束 → 日志包含全部 8 行 + 退出码
 *
 * 运行: bun run packages/tools/src/__tests__/exec-timeout-bg-output-poc.ts
 */

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEMP_DIR = ".temp";
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

interface TimeoutResult {
	timedOut: true;
	pid: number;
	logFile: string;
	stdoutSoFar: string;
	stderrSoFar: string;
	durationMs: number;
	/** resolve 当后台协程完成时 */
	backgroundDone: Promise<void>;
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

	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const pid = proc.pid;

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

	let timedOut = false;
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		setTimeout(() => {
			timedOut = true;
			resolve("timeout");
		}, timeoutMs);
	});

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
		const logFile = join(TEMP_DIR, `exec_bg_${pid}_${Date.now()}.log`);
		const stdoutSoFar = stdoutChunks.join("");
		const stderrSoFar = stderrChunks.join("");

		await Bun.write(logFile, `--- stdout so far ---\n${stdoutSoFar}\n--- stderr so far ---\n${stderrSoFar}\n--- background continues ---\n`);

		// 后台协程：继续收集直到流关闭，然后写入完整日志
		const backgroundDone = (async () => {
			while (streamsDone < 2) {
				await new Promise<void>((r) => { notify = () => r(); });
				notify = null;
			}
			const exitCode = await proc.exited;
			const finalStdout = stdoutChunks.join("");
			const finalStderr = stderrChunks.join("");
			await Bun.write(
				logFile,
				`--- stdout (complete) ---\n${finalStdout}\n--- stderr (complete) ---\n${finalStderr}\n--- Process exited with code ${exitCode} ---\n`,
			);
		})();

		return { timedOut: true, pid, logFile, stdoutSoFar, stderrSoFar, durationMs, backgroundDone };
	}

	const exitCode = await proc.exited;
	return {
		timedOut: false,
		exitCode,
		stdout: stdoutChunks.join(""),
		stderr: stderrChunks.join(""),
		durationMs,
	};
}

// ── 测试 ──

const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

console.log("▶ 验证：超时后后台继续执行，后续输出写入日志文件\n");

// 脚本：每 0.5s 输出一行，共 8 行（总耗时 4s）
const script = `for i in 1 2 3 4 5 6 7 8; do echo "line_$i"; sleep 0.5; done; echo "DONE"`;
const result = await execWithFixedTimeout(["sh", "-c", script], 2);

assert(result.timedOut === true, "应超时");
console.log(`1️⃣  超时返回: timedOut=true, PID=${result.pid}, 耗时=${result.durationMs}ms`);

const soFarLines = result.stdoutSoFar.trim().split("\n").filter(Boolean);
console.log(`2️⃣  超时前捕获 ${soFarLines.length} 行: ${soFarLines.join(", ")}`);
assert(soFarLines.length >= 2 && soFarLines.length <= 5, `超时前应捕获 2-5 行，实际: ${soFarLines.length}`);

console.log(`3️⃣  日志文件: ${result.logFile}`);
const midLog = await Bun.file(result.logFile).text();
console.log(`   超时时日志内容:\n${midLog.split("\n").map(l => "   | " + l).join("\n")}`);

// 等待后台进程完成（脚本总共 4s，timeout 2s，还需等约 2-3s）
console.log(`4️⃣  等待后台进程完成...`);
await result.backgroundDone;
console.log(`   后台进程已退出`);

// 读取最终日志
const finalLog = await Bun.file(result.logFile).text();
console.log(`5️⃣  最终日志内容:\n${finalLog.split("\n").map(l => "   | " + l).join("\n")}`);

// 验证：最终日志包含全部 8 行 + DONE + 退出码
assert(finalLog.includes("line_8"), "日志应包含 line_8（最后一行输出）");
assert(finalLog.includes("DONE"), "日志应包含 DONE");
assert(finalLog.includes("exited with code 0"), "日志应包含退出码 0");

const finalLines = finalLog.match(/line_\d+/g) ?? [];
console.log(`\n6️⃣  最终日志包含 ${finalLines.length} 行输出: ${finalLines.join(", ")}`);
assert(finalLines.length === 8, `日志应包含全部 8 行，实际: ${finalLines.length}`);

console.log("\n✅ 全部验证通过：超时后进程继续执行，后续输出完整记录到日志文件");
process.exit(0);
