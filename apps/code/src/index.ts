/**
 * Code Agent — 入口
 *
 * 代码编写场景的 agent，产出物为项目代码变更（而非 workflow）。
 * 使用 --workspace 指定目标项目目录；不会修改全局 process.cwd()。
 */

import { resolve } from "node:path";
import { initConfig } from "@n0n/core";

const rawArgs = process.argv.slice(2);
const workspaceIdx = rawArgs.indexOf("--workspace");
const workspaceArg = workspaceIdx >= 0 ? rawArgs[workspaceIdx + 1] : undefined;
if (workspaceIdx >= 0) {
	if (!workspaceArg) {
		console.error("--workspace requires a directory argument");
		process.exit(1);
	}
	rawArgs.splice(workspaceIdx, 2);
}

const workspace = resolve(
	workspaceArg ??
		process.env.N0N_CODE_WORKSPACE ??
		resolve(process.cwd(), ".runtime", "code"),
);
const workspacePaths = initConfig({
	workspace,
	temp: ".temp",
});

const { style, writeln } = await import("@n0n/cli-ui");
const { startCodeRepl } = await import("./repl.ts");

const initialInput = rawArgs.length > 0 ? rawArgs.join(" ") : undefined;

writeln(
	style.bold("n0n code") +
		style.gray(` — Code Agent [${workspacePaths.workspace}]`),
);
writeln(
	style.gray('描述你的编码任务，AI 将直接修改项目代码。输入 "exit" 退出。'),
);
writeln();

await startCodeRepl(workspacePaths, initialInput);
