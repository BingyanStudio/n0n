/**
 * exec 格式化 snapshot 生成器
 *
 * 生成三种 ExecToolResult 状态的格式化结果，写入 snapshot 文件供人工检查。
 * 运行: bun run packages/shared/src/__tests__/exec-format-snapshot.ts
 */

import { formatPrompt } from "../format-prompt.ts";
import type { DomainMessage } from "@n0n/types";

const MODEL = "claude-sonnet-4-20250514";

const completed: DomainMessage = {
	type: "tool_result",
	tool: "exec",
	status: "completed",
	call: {
		id: "call_1",
		tool: "exec",
		args: { script: "echo hello && ls -la", runtime: "sh", cwd: "src" },
	},
	exitCode: 0,
	stdout: "hello\ntotal 16\ndrwxr-xr-x  4 user staff  128 Jan  1 00:00 .\ndrwxr-xr-x  8 user staff  256 Jan  1 00:00 ..",
	stderr: "",
	durationMs: 12,
};

const completedError: DomainMessage = {
	type: "tool_result",
	tool: "exec",
	status: "completed",
	call: {
		id: "call_2",
		tool: "exec",
		args: { script: "cat missing.txt" },
	},
	exitCode: 1,
	stdout: "",
	stderr: "cat: missing.txt: No such file or directory",
	durationMs: 5,
};

const truncated: DomainMessage = {
	type: "tool_result",
	tool: "exec",
	status: "truncated",
	call: {
		id: "call_3",
		tool: "exec",
		args: { script: "find . -name '*.ts'", runtime: "sh" },
	},
	exitCode: 0,
	stdoutTail: "./packages/tools/src/exec/executor.ts\n./packages/tools/src/exec/security.ts\n./packages/tools/src/exec/index.ts\n./packages/types/src/domain.ts",
	stderrTail: "",
	outputFile: ".temp/exec_output_call_3_1775063000000.txt",
	stdoutLength: 28450,
	stderrLength: 0,
	durationMs: 320,
};

const timedOut: DomainMessage = {
	type: "tool_result",
	tool: "exec",
	status: "timed_out",
	call: {
		id: "call_4",
		tool: "exec",
		args: { script: "npm install", timeout: 30 },
	},
	pid: 65432,
	logFile: ".temp/exec_bg_65432_1775062634766.log",
	stdoutSoFar: "npm warn deprecated inflight@1.0.6\nadded 142 packages in 28s",
	stderrSoFar: "",
	durationMs: 30003,
};

const scenarios = [
	{ name: "completed (success)", msg: completed },
	{ name: "completed (error)", msg: completedError },
	{ name: "truncated", msg: truncated },
	{ name: "timed_out", msg: timedOut },
];

const lines: string[] = [
	"# exec formatPrompt snapshot",
	`# model: ${MODEL}`,
	`# generated: ${new Date().toISOString()}`,
	"",
];

for (const { name, msg } of scenarios) {
	const result = formatPrompt([msg], MODEL);
	const content = result[0]?.role === "tool" ? result[0].content : "(unexpected role)";

	lines.push(`## ${name}`, "");
	lines.push("```", content, "```", "");
}

const output = lines.join("\n");
const outPath = "packages/shared/src/__tests__/__snapshots__/exec-format.snapshot.md";
await Bun.write(outPath, output);
console.log(`Snapshot written to ${outPath}`);
console.log("\n" + output);
