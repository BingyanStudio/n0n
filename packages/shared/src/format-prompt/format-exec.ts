/**
 * exec tool result 格式化 — 含 anti-few-shot 变体
 *
 * 多部分拼装（meta、stdout/stderr tag、hint 等）各自使用
 * msgIndex+N 偏移独立选择变体，组合爆炸产生远超单维度的多样性。
 */

import type { ExecToolResult } from "@n0n/types";
import { pick, wrapTag } from "./utils.ts";

// ── 变体模板 ──

const metaTemplates = [
	(rt: string, cwd: string, exit: number, ms: number) =>
		`[${rt}] [cwd: ${cwd}] [exit: ${exit}] [${ms}ms]`,
	(rt: string, cwd: string, exit: number, ms: number) =>
		`runtime=${rt} cwd=${cwd} exitCode=${exit} duration=${ms}ms`,
	(rt: string, cwd: string, exit: number, ms: number) =>
		`(${rt}) ${cwd} | exit ${exit} | ${ms}ms`,
];

const timedOutMetaTemplates = [
	(rt: string, cwd: string, ms: number) =>
		`[${rt}] [cwd: ${cwd}] [timed out after ${ms}ms]`,
	(rt: string, cwd: string, ms: number) =>
		`runtime=${rt} cwd=${cwd} status=timed_out after ${ms}ms`,
	(rt: string, cwd: string, ms: number) =>
		`(${rt}) ${cwd} | timed out | ${ms}ms`,
];

const truncatedMetaTemplates = [
	(rt: string, cwd: string, exit: number, ms: number, file: string) =>
		`[${rt}] [cwd: ${cwd}] [exit: ${exit}] [${ms}ms] [output truncated → ${file}]`,
	(rt: string, cwd: string, exit: number, ms: number, file: string) =>
		`runtime=${rt} cwd=${cwd} exitCode=${exit} duration=${ms}ms truncated→${file}`,
	(rt: string, cwd: string, exit: number, ms: number, file: string) =>
		`(${rt}) ${cwd} | exit ${exit} | ${ms}ms | truncated to ${file}`,
];

const timeoutNoticeTemplates = [
	(pid: number, logFile: string) =>
		`Process exceeded timeout, moved to background.\nPID: ${pid}\nLog file: ${logFile}\nRead the log file later to check process status.`,
	(pid: number, logFile: string) =>
		`Timed out — process continues in background (PID ${pid}).\nOutput is being logged to: ${logFile}\nCheck the log file for progress.`,
	(pid: number, logFile: string) =>
		`Background process started (PID: ${pid}).\nThe command timed out but is still running.\nMonitor via log: ${logFile}`,
];

/** 格式化截断分块的读取建议 */
function formatChunkGuide(
	chunks: { startLine: number; endLine: number; tokens: number }[],
	outputFile: string,
): string {
	if (chunks.length === 0) return "";
	if (chunks.length === 1) {
		const c = chunks[0]!;
		return `Truncated part: lines ${c.startLine}-${c.endLine} (~${c.tokens} tokens) — small enough to read in one go if needed.`;
	}
	const lines = chunks.map(
		(c, i) => `  chunk ${i + 1}: lines ${c.startLine}-${c.endLine} (~${c.tokens} tok)`,
	);
	return `Truncated part can be read in ${chunks.length} chunks:\n${lines.join("\n")}\nUse sed -n '<start>,<end>p' ${outputFile} to read a specific chunk.`;
}

const truncatedHintTemplates = [
	(totalLines: number, outputFile: string, chunkGuide: string) =>
		`Full output (${totalLines} lines) saved to: ${outputFile}\n${chunkGuide}\nOr write a script to extract key information — do NOT cat the full file.`,
	(totalLines: number, outputFile: string, chunkGuide: string) =>
		`${totalLines} lines captured in ${outputFile}.\n${chunkGuide}\nPrefer writing a script to extract what you need rather than reading raw output.`,
	(totalLines: number, outputFile: string, chunkGuide: string) =>
		`Complete output saved to ${outputFile} (${totalLines} lines).\n${chunkGuide}\nUse targeted reads (sed/head/tail) or a script — avoid re-dumping the full file.`,
];

const diagnosticHintTemplates = [
	"Package/module not found. Possible causes: (1) the package is not listed in the project root dependencies — check package.json; (2) dependencies not installed — run the appropriate install command; (3) for Python with uv, declare inline dependencies using PEP 723 `# /// script` metadata.",
	"Module resolution failed. Check: (1) Is the package in package.json? (2) Have dependencies been installed? (3) For uv/Python, use PEP 723 inline `# /// script` dependency declarations.",
	"Cannot resolve package/module. Verify: (1) package.json lists it as a dependency; (2) install has been run; (3) Python scripts using uv should declare deps with PEP 723 `# /// script` metadata.",
];

const stdoutTagNames = ["stdout", "output", "console_output"];
const stderrTagNames = ["stderr", "error_output", "console_error"];

// ── 格式化函数 ──

export function formatExecResult(
	msg: ExecToolResult,
	model: string,
	msgIndex: number,
): string {
	const runtime = msg.call.args.runtime ?? "unknown";
	const cwd = msg.call.args.cwd ?? ".";
	// 每个 pick 点用不同偏移：meta=+0, stdoutTag=+1, stderrTag=+2, notice/hint=+3, diagnostic=+4
	const stdoutTag = pick(stdoutTagNames, msgIndex + 1);
	const stderrTag = pick(stderrTagNames, msgIndex + 2);

	switch (msg.status) {
		case "timed_out": {
			const metaFn = pick(timedOutMetaTemplates, msgIndex);
			const parts = [wrapTag("exec_meta", metaFn(runtime, cwd, msg.durationMs), model)];

			const noticeFn = pick(timeoutNoticeTemplates, msgIndex + 3);
			parts.push(wrapTag("timeout_notice", noticeFn(msg.pid, msg.logFile), model));

			if (msg.stdoutSoFar)
				parts.push(wrapTag(stdoutTag, msg.stdoutSoFar, model));
			if (msg.stderrSoFar)
				parts.push(wrapTag(stderrTag, msg.stderrSoFar, model));
			return parts.join("\n");
		}
		case "truncated": {
			const metaFn = pick(truncatedMetaTemplates, msgIndex);
			const parts = [wrapTag("exec_meta", metaFn(runtime, cwd, msg.exitCode, msg.durationMs, msg.outputFile), model)];

			if (msg.stdoutTail)
				parts.push(
					wrapTag(
						stdoutTag,
						`... (last ${msg.totalLines - msg.tailStartLine + 1} of ${msg.totalLines} lines)\n${msg.stdoutTail}`,
						model,
					),
				);
			if (msg.stderrTail)
				parts.push(
					wrapTag(stderrTag, `... (truncated)\n${msg.stderrTail}`, model),
				);

			const hintFn = pick(truncatedHintTemplates, msgIndex + 3);
			const chunkGuide = formatChunkGuide(msg.truncatedChunks, msg.outputFile);
			parts.push(wrapTag("output_hint", hintFn(msg.totalLines, msg.outputFile, chunkGuide), model));
			return parts.join("\n");
		}
		case "completed": {
			const metaFn = pick(metaTemplates, msgIndex);
			const parts = [wrapTag("exec_meta", metaFn(runtime, cwd, msg.exitCode, msg.durationMs), model)];

			if (msg.stdout) parts.push(wrapTag(stdoutTag, msg.stdout, model));
			if (msg.stderr) parts.push(wrapTag(stderrTag, msg.stderr, model));

			const combined = (msg.stdout || "") + (msg.stderr || "");
			if (
				msg.exitCode !== 0 &&
				/Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|No module named/i.test(
					combined,
				)
			) {
				parts.push(wrapTag("diagnostic_hint", pick(diagnosticHintTemplates, msgIndex + 4), model));
			}
			return parts.join("\n");
		}
		default: {
			const _exhaustive: never = msg;
			// biome-ignore lint/suspicious/noExplicitAny: exhaustive switch default
			return `Unknown exec status: ${(msg as any).status}`;
		}
	}
}
