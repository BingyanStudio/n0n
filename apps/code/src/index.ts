/**
 * Code Agent — 入口
 *
 * 代码编写场景的 agent，产出物为项目代码变更（而非 workflow）。
 * 使用 --workspace 指定目标项目目录；不会修改全局 process.cwd()。
 *
 * 启动流程：
 * 1. bootstrap — 检测 .env / 必填配置 / LLM 连通性，缺什么补什么
 * 2. 初始化运行时上下文
 * 3. 启动 REPL
 */

import { CliSetupRenderer, style, writeln } from "@n0n/cli-ui";
import { createRuntimeContext, initRuntime } from "@n0n/core";
import {
	bootstrap,
	ensureDirs,
	parseWorkspaceArg,
	resolveBasePaths,
} from "@n0n/shared";

import { codeEnvSpec } from "./env-spec.ts";

// ── Bootstrap ──

const setupUI = new CliSetupRenderer();
const result = await bootstrap(codeEnvSpec, setupUI);
setupUI.dispose();

if (!result.ok) {
	process.exit(1);
}

// ── 初始化 ──

const { workspace, remainingArgs } = parseWorkspaceArg(
	process.argv.slice(2),
	"N0N_CODE_WORKSPACE",
	`${process.cwd()}/.runtime/code`,
);

const paths = resolveBasePaths(workspace);
ensureDirs(paths);
const runtime = createRuntimeContext();
initRuntime(runtime);

const { startCodeRepl } = await import("./repl.ts");

const initialInput =
	remainingArgs.length > 0 ? remainingArgs.join(" ") : undefined;

writeln(
	style.bold("n0n code") + style.gray(` — Code Agent [${paths.workspace}]`),
);
writeln(
	style.gray('描述你的编码任务，AI 将直接修改项目代码。输入 "exit" 退出。'),
);
writeln();

await startCodeRepl(paths, initialInput);
