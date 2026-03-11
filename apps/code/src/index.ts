/**
 * Code Agent — 入口
 *
 * 代码编写场景的 agent，产出物为项目代码变更（而非 workflow）。
 * 使用 --workspace 指定目标项目目录；不会修改全局 process.cwd()。
 */

import {
	createRuntimeContext,
	initRuntime,
	parseWorkspaceArg,
	resolveBasePaths,
	ensureDirs,
} from "@n0n/core";

const { workspace, remainingArgs } = parseWorkspaceArg(
	process.argv.slice(2),
	"N0N_CODE_WORKSPACE",
	`${process.cwd()}/.runtime/code`,
);

const paths = resolveBasePaths(workspace);
ensureDirs(paths);
const runtime = createRuntimeContext();
initRuntime(runtime, paths);

const { style, writeln } = await import("@n0n/cli-ui");
const { startCodeRepl } = await import("./repl.ts");

const initialInput = remainingArgs.length > 0 ? remainingArgs.join(" ") : undefined;

writeln(
	style.bold("n0n code") +
		style.gray(` — Code Agent [${paths.workspace}]`),
);
writeln(
	style.gray('描述你的编码任务，AI 将直接修改项目代码。输入 "exit" 退出。'),
);
writeln();

await startCodeRepl(paths, initialInput);
