/**
 * exec tool result 格式化 — 含 anti-few-shot 变体
 */

import type { ExecToolResult } from "@n0n/types";
import { pick, wrapTag } from "./utils.ts";

// ── 变体模板 ──

interface MetaTemplate {
	format: (runtime: string, cwd: string, exit: number, ms: number) => string;
}

const metaTemplates: MetaTemplate[] = [
	{
		format: (rt, cwd, exit, ms) =>
			`[${rt}] [cwd: ${cwd}] [exit: ${exit}] [${ms}ms]`,
	},
	{
		format: (rt, cwd, exit, ms) =>
			`runtime=${rt} cwd=${cwd} exitCode=${exit} duration=${ms}ms`,
	},
	{
		format: (rt, cwd, exit, ms) =>
			`(${rt}) ${cwd} | exit ${exit} | ${ms}ms`,
	},
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
	(pid: number, logFile: string) => [
		`Process exceeded timeout, moved to background.`,
		`PID: ${pid}`,
		`Log file: ${logFile}`,
		`Read the log file later to check process status.`,
	].join("\n"),
	(pid: number, logFile: string) => [
		`Timed out — process continues in background (PID ${pid}).`,
		`Output is being logged to: ${logFile}`,
		`Check the log file for progress.`,
	].join("\n"),
	(pid: number, logFile: string) => [
		`Background process started (PID: ${pid}).`,
		`The command timed out but is still running.`,
		`Monitor via log: ${logFile}`,
	].join("\n"),
];

const truncatedHintTemplates = [
	(totalLines: number, outputFile: string) => [
		`Full output (${totalLines} lines) written to: ${outputFile}`,
		`Use exec to read specific parts: grep, sed, head, tail, or bun script.`,
		`Do NOT re-cat the full file — it will be truncated again.`,
	].join("\n"),
	(totalLines: number, outputFile: string) => [
		`Complete output saved to ${outputFile} (${totalLines} lines total).`,
		`Read selectively with grep, head, tail, or a script — do not cat the whole file.`,
	].join("\n"),
	(totalLines: number, outputFile: string) => [
		`${totalLines} lines captured in ${outputFile}.`,
		`Extract what you need with targeted commands (grep/sed/head/tail).`,
		`Avoid re-dumping the full file — it will truncate again.`,
	].join("\n"),
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
	const stdoutTag = pick(stdoutTagNames, msgIndex);
	const stderrTag = pick(stderrTagNames, msgIndex + 1000);

	switch (msg.status) {
		case "timed_out": {
			const metaFn = pick(timedOutMetaTemplates, msgIndex);
			const meta = metaFn(runtime, cwd, msg.durationMs);
			const parts = [wrapTag("exec_meta", meta, model)];

			const noticeFn = pick(timeoutNoticeTemplates, msgIndex);
			parts.push(wrapTag("timeout_notice", noticeFn(msg.pid, msg.logFile), model));

			if (msg.stdoutSoFar)
				parts.push(wrapTag(stdoutTag, msg.stdoutSoFar, model));
			if (msg.stderrSoFar)
				parts.push(wrapTag(stderrTag, msg.stderrSoFar, model));
			return parts.join("\n");
		}
		case "truncated": {
			const metaFn = pick(truncatedMetaTemplates, msgIndex);
			const meta = metaFn(runtime, cwd, msg.exitCode, msg.durationMs, msg.outputFile);
			const parts = [wrapTag("exec_meta", meta, model)];

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

			const hintFn = pick(truncatedHintTemplates, msgIndex);
			parts.push(wrapTag("output_hint", hintFn(msg.totalLines, msg.outputFile), model));
			return parts.join("\n");
		}
		case "completed": {
			const metaTpl = pick(metaTemplates, msgIndex);
			const meta = metaTpl.format(runtime, cwd, msg.exitCode, msg.durationMs);
			const parts = [wrapTag("exec_meta", meta, model)];

			if (msg.stdout) parts.push(wrapTag(stdoutTag, msg.stdout, model));
			if (msg.stderr) parts.push(wrapTag(stderrTag, msg.stderr, model));

			const combined = (msg.stdout || "") + (msg.stderr || "");
			if (
				msg.exitCode !== 0 &&
				/Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|No module named/i.test(
					combined,
				)
			) {
				const hint = pick(diagnosticHintTemplates, msgIndex);
				parts.push(wrapTag("diagnostic_hint", hint, model));
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
