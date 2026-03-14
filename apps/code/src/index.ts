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

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
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
// 配置文件存放在全局目录 ~/.n0n/，避免每个工作目录都需要重新配置
const globalConfigDir = resolve(homedir(), ".n0n");
if (!existsSync(globalConfigDir)) {
	mkdirSync(globalConfigDir, { recursive: true });
}

const setupUI = new CliSetupRenderer();
const result = await bootstrap(codeEnvSpec, setupUI, globalConfigDir);
setupUI.dispose();

if (!result.ok) {
	process.exit(1);
}

// ── 解析参数 ──
const args = process.argv.slice(2);
const useTui = args.includes("--tui");

// 过滤掉已知标志，避免被当作 workspace 或 initialInput
const filteredArgs = args.filter((arg) => arg !== "--tui");

// ── 初始化 ──

const { workspace, remainingArgs } = parseWorkspaceArg(
	filteredArgs,
	"N0N_CODE_WORKSPACE",
	process.cwd(),
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
if (useTui) {
	writeln(style.gray("使用 TUI 渲染器（实验性）"));
}
writeln(
	style.gray('描述你的编码任务，AI 将直接修改项目代码。输入 "exit" 退出。'),
);
writeln();

await startCodeRepl(paths, initialInput, { useTui });
