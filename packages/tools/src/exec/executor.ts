/**
 * exec 命令执行器
 *
 * 将模型提供的 script 写入临时文件，用指定 runtime 执行。
 *
 * 等待架构（为什么用 Promise.race 而不是 setTimeout + kill）：
 * 旧方案 setTimeout → proc.kill() 依赖一个脆弱假设：kill 信号能让 stdout/stderr
 * 流关闭从而唤醒读取循环。实际上常不成立：
 * - shell 脚本 fork 的子进程不受 kill 影响，继续持有管道
 * - 某些进程捕获/忽略 SIGTERM
 * - 子进程继承管道 fd，即使父进程退出流也不关闭
 * 结果：流读取的 await 永远不 resolve，agent 主循环卡死。
 *
 * 当前方案：Promise.race 让等待 Promise 与流读取 Promise 竞争，确定性中断。
 * 等待超限后进程转入后台继续执行，已捕获输出 + 后续输出写入 .temp/ 日志文件。
 */

// DESIGN NOTE: buildSpawnCmd 用 switch 硬编码每个 runtime 的执行命令，
// 而非从某个 RuntimeProvider.spawnCmd() 动态获取。理由同 env.ts 顶部的
// DESIGN NOTE——runtime 列表稳定，且各 runtime 的 spawn 参数差异大
//（如 deno 需要 --allow-all，pwsh 需要 -NoProfile -File），
// 一个 switch 比一套接口 + 10 个实现文件更容易一眼看全。
// —— Mebius ∞

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	estimateTokens,
	splitLinesByTokenBudget,
	tailByTokens,
} from "@n0n/shared";
import type {
	ExecToolCall,
	ExecToolResult,
	ToolOutputChunk,
	ToolStreamEvent,
} from "@n0n/types";
import { findBlockedCommand, handleBlockedCommand } from "./security.ts";

const IS_WINDOWS = process.platform === "win32";

/** 生成简短的截断输出文件名，自动避让已有文件 */
function makeShortOutputPath(tempDir: string): string {
	const rand = Math.random().toString(36).slice(2, 8);
	const name = `exec_output_${rand}.txt`;
	const full = join(tempDir, name);
	// 极小概率冲突时重试
	if (existsSync(full)) return makeShortOutputPath(tempDir);
	return full;
}

const DEFAULT_RUNTIME = IS_WINDOWS ? "cmd" : "sh";

/** runtime → 临时文件扩展名 */
const RUNTIME_EXT: Record<string, string> = {
	sh: ".sh",
	bash: ".sh",
	cmd: ".cmd",
	pwsh: ".ps1",
	bun: ".ts",
	node: ".mjs",
	deno: ".ts",
	python: ".py",
	python3: ".py",
	uv: ".py",
};

/** runtime → 执行命令构造器 */
function buildSpawnCmd(runtime: string, tmpFile: string): string[] {
	switch (runtime) {
		case "cmd":
			return ["cmd", "/c", tmpFile];
		case "sh":
		case "bash":
			return [runtime, tmpFile];
		case "pwsh":
			return ["pwsh", "-NoProfile", "-File", tmpFile];
		case "bun":
			return ["bun", "run", tmpFile];
		case "node":
			return ["node", tmpFile];
		case "deno":
			return ["deno", "run", "--allow-all", tmpFile];
		case "python":
		case "python3":
			return [runtime, tmpFile];
		case "uv":
			return ["uv", "run", tmpFile];
		default:
			return [runtime, tmpFile];
	}
}

/** 超过此阈值（stdout+stderr 合计预估 token 数）触发截断写文件 */
const TRUNCATION_THRESHOLD_TOKENS = 5_000;
/** 截断后展示的末尾 token 数 */
const TAIL_TOKENS = 2_000;

/**
 * 流式执行脚本。
 *
 * 等待机制：使用 Promise.race 让等待 Promise 与流读取竞争，
 * 确定性中断。等待超限后进程不被 kill，而是转入后台继续执行，
 * 已收集的输出和后续输出写入 .temp/ 日志文件。
 */
export async function* execToolStream(
	call: ExecToolCall,
	confirmFn: ((question: string) => Promise<string>) | undefined,
	toolsConfig: {
		workspace: string;
		tempDir: string;
		blockedCommands: string[];
		defaultExecWaitfor: number;
	},
): AsyncGenerator<ToolStreamEvent> {
	const runtime = call.args.runtime ?? DEFAULT_RUNTIME;
	const workspace = toolsConfig.workspace;
	const cwd = call.args.cwd
		? isAbsolute(call.args.cwd)
			? call.args.cwd
			: resolve(workspace, call.args.cwd)
		: workspace;
	// prompt cache 的 TTL 为 5 分钟，等待过长会导致缓存失效
	const MAX_WAITFOR_S = 240;
	const waitforS = Math.min(
		call.args.waitfor ?? toolsConfig.defaultExecWaitfor,
		MAX_WAITFOR_S,
	);
	const waitforMs = waitforS * 1000;
	const start = Date.now();

	// Security check
	const blockedCmd = findBlockedCommand(
		call.args.script,
		toolsConfig.blockedCommands,
	);
	if (blockedCmd !== null) {
		const blocked = await handleBlockedCommand(
			call,
			cwd,
			blockedCmd,
			confirmFn,
		);
		if (blocked) {
			yield blocked;
			return;
		}
	}

	// Write script to temp file
	const ext = RUNTIME_EXT[runtime] ?? "";
	const tempDir = resolve(toolsConfig.tempDir);
	if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
	const tmpFile = join(
		tempDir,
		`_n0n_exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`,
	);

	try {
		const scriptContent =
			runtime === "cmd" ? `@${call.args.script}\n` : call.args.script;
		await Bun.write(tmpFile, scriptContent);

		const spawnCmd = buildSpawnCmd(runtime, tmpFile);
		const proc = Bun.spawn(spawnCmd, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const decoder = new TextDecoder();

		const pending: ToolOutputChunk[] = [];
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
					const text = decoder.decode(value, { stream: true });
					bucket.push(text);
					pending.push({
						type: "tool_output_chunk",
						callId: call.id,
						tool: "exec",
						chunk: text,
					});
					notify?.();
				}
			} finally {
				reader.releaseLock();
				streamsDone++;
				notify?.();
			}
		};

		if (!proc.stdout || !proc.stderr) {
			throw new Error("Failed to capture process streams (stdout/stderr)");
		}
		pumpStream(proc.stdout, stdoutChunks);
		pumpStream(proc.stderr, stderrChunks);

		// ── 等待机制：Promise.race 确定性中断 ──
		let backgrounded = false;
		const waitforPromise = new Promise<"waitfor">((resolve) => {
			setTimeout(() => {
				backgrounded = true;
				resolve("waitfor");
			}, waitforMs);
		});

		while (streamsDone < 2 || pending.length > 0) {
			if (backgrounded) break;
			if (pending.length === 0) {
				const waitForData = new Promise<"data">((r) => {
					notify = () => r("data");
				});
				const raceResult = await Promise.race([waitForData, waitforPromise]);
				notify = null;
				if (raceResult === "waitfor") break;
			}
			while (pending.length > 0) {
				const chunk = pending.shift();
				if (chunk) yield chunk;
			}
		}

		if (backgrounded) {
			// ── 等待超限路径：写日志，后台定期同步 ──
			const durationMs = Date.now() - start;
			const pid = proc.pid;
			const logFile = join(tempDir, `exec_bg_${pid}.log`);
			const startedAt = new Date(start).toISOString();
			const stdoutSoFar = stdoutChunks.join("");
			const stderrSoFar = stderrChunks.join("");

			/** 构建 bg 文件内容：输出 + 元数据块 */
			const buildLogContent = (opts: {
				status: "running" | "exited";
				stdout: string;
				stderr: string;
				exitCode?: number;
				endedAt?: string;
				totalDurationMs?: number;
			}): string => {
				const now = new Date().toISOString();
				const stdoutSection = `--- stdout ---\n${opts.stdout || "(empty)"}`;
				const stderrSection = `--- stderr ---\n${opts.stderr || "(empty)"}`;

				const metaLines = [`pid: ${pid}`, `status: ${opts.status}`, `started_at: ${startedAt}`];

				if (opts.status === "running") {
					metaLines.push(`last_updated: ${now}`);
					metaLines.push(
						`note: If current time is far ahead of last_updated, log sync may be delayed — verify process status via PID. If current time is close to last_updated and content unchanged, the process likely has no new output.`,
					);
				} else {
					// exited
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
			};

			// 初始写入
			await Bun.write(
				logFile,
				buildLogContent({ status: "running", stdout: stdoutSoFar, stderr: stderrSoFar }),
			);

			// 启动后台协程：定期同步 + 等待进程结束
			(async () => {
				const SYNC_INTERVAL_MS = 3000;
				let syncTimer: ReturnType<typeof setInterval> | null = null;

				const syncToFile = () => {
					const currentStdout = stdoutChunks.join("");
					const currentStderr = stderrChunks.join("");
					// 非阻塞写入（fire-and-forget 在 interval 中）
					Bun.write(
						logFile,
						buildLogContent({ status: "running", stdout: currentStdout, stderr: currentStderr }),
					);
				};

				try {
					// 定期同步：即使没有新输出也更新 last_updated 时间戳
					syncTimer = setInterval(syncToFile, SYNC_INTERVAL_MS);

					// 等待流结束 — 使用 polling + sleep 替代 notify 避免竞态
					while (streamsDone < 2) {
						await new Promise<void>((r) => setTimeout(r, 500));
					}

					const exitCode = await proc.exited;
					const endedAt = new Date().toISOString();
					const totalDurationMs = Date.now() - start;
					const finalStdout = stdoutChunks.join("");
					const finalStderr = stderrChunks.join("");

					await Bun.write(
						logFile,
						buildLogContent({
							status: "exited",
							stdout: finalStdout,
							stderr: finalStderr,
							exitCode,
							endedAt,
							totalDurationMs,
						}),
					);
				} catch {
					// 后台协程出错不影响主流程
				} finally {
					if (syncTimer) clearInterval(syncTimer);
					try {
						unlinkSync(tmpFile);
					} catch {
						// ignore cleanup errors
					}
				}
			})();

			yield {
				type: "tool_result",
				tool: "exec" as const,
				call,
				status: "backgrounded",
				pid,
				logFile,
				stdoutSoFar: tailByTokens(stdoutSoFar, TAIL_TOKENS),
				stderrSoFar: tailByTokens(stderrSoFar, TAIL_TOKENS),
				durationMs,
			} satisfies ExecToolResult;
			return; // 不进入 finally 删除临时文件（后台协程负责）
		}

		// ── 正常完成路径 ──
		const exitCode = await proc.exited;
		const durationMs = Date.now() - start;
		const stdout = stdoutChunks.join("");
		const stderr = stderrChunks.join("");

		const totalTokens = estimateTokens(stdout + stderr);

		if (totalTokens > TRUNCATION_THRESHOLD_TOKENS) {
			// ── 截断路径：完整输出写入文件 ──
			const outputFile = makeShortOutputPath(tempDir);
			const fileContent = [
				stdout,
				"--- stderr ---",
				stderr,
				`--- exit code: ${exitCode} ---`,
			].join("\n");
			await Bun.write(outputFile, fileContent);

			const stdoutTail = tailByTokens(stdout, TAIL_TOKENS);

			// 被截断的前半部分按 token 预算分块，帮助模型精确读取
			const truncatedText = stdout.substring(
				0,
				stdout.length - stdoutTail.length,
			);
			const truncatedChunks =
				truncatedText.length > 0
					? splitLinesByTokenBudget(truncatedText, TAIL_TOKENS)
					: [];
			const totalLines = stdout.split("\n").length + stderr.split("\n").length;
			const tailLines = stdoutTail.split("\n").length;
			const tailStartLine = totalLines - tailLines + 1;

			yield {
				type: "tool_result",
				tool: "exec" as const,
				call,
				status: "truncated",
				exitCode,
				stdoutTail,
				stderrTail: tailByTokens(stderr, TAIL_TOKENS),
				outputFile,
				stdoutLength: stdout.length,
				stderrLength: stderr.length,
				totalLines,
				tailStartLine,
				truncatedChunks,
				durationMs,
			} satisfies ExecToolResult;
		} else {
			// ── 正常路径：输出直接返回 ──
			const hasOutput = stdout.trim() || stderr.trim();
			const hint =
				!hasOutput && exitCode === 0
					? "(no output — script may not have top-level executable code, or async operations may not have been awaited.)"
					: "";

			yield {
				type: "tool_result",
				tool: "exec" as const,
				call,
				status: "completed",
				exitCode,
				stdout: hint || stdout,
				stderr,
				durationMs,
			} satisfies ExecToolResult;
		}
	} catch (err) {
		yield {
			type: "tool_result",
			tool: "exec" as const,
			call,
			status: "completed" as const,
			exitCode: 1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - start,
		} satisfies ExecToolResult;
	} finally {
		// 正常路径清理临时文件（超时路径由后台协程负责，已 return）
		try {
			unlinkSync(tmpFile);
		} catch {
			// ignore cleanup errors
		}
	}
}
