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
import { buildLLMConfigFromEnv, createModelFromConfig } from "@n0n/llm";
import {
	bootstrap,
	ensureDirs,
	parseWorkspaceArg,
	resolveBasePaths,
} from "@n0n/shared";
import { generateText } from "ai";

import { codeEnvSpec } from "./env-spec.ts";

// ── Bootstrap ──
// 配置文件存放在全局目录 ~/.n0n/，避免每个工作目录都需要重新配置
const globalConfigDir = resolve(homedir(), ".n0n");
if (!existsSync(globalConfigDir)) {
	mkdirSync(globalConfigDir, { recursive: true });
}

const setupUI = new CliSetupRenderer();

/** LLM 连通性测试回调 — 注入到 bootstrap，避免 shared 直接依赖 llm */
const testLLM = async () => {
	try {
		const config = buildLLMConfigFromEnv("LLM");
		const model = createModelFromConfig(config);
		await generateText({
			model,
			messages: [{ role: "user", content: "hi" }],
			maxOutputTokens: 1,
			maxRetries: 1,
		});
		return { ok: true as const };
	} catch (err) {
		if (err instanceof Error) {
			if (err.message.includes("401") || err.message.includes("403")) {
				return { ok: false as const, error: "认证失败，请检查 API Key" };
			}
			if (err.name === "TimeoutError" || err.message.includes("timeout")) {
				return {
					ok: false as const,
					error: "连接超时（15s），请检查网络或 API 地址",
				};
			}
			return { ok: false as const, error: err.message.slice(0, 200) };
		}
		return { ok: false as const, error: `连接失败: ${String(err)}` };
	}
};

const result = await bootstrap(codeEnvSpec, setupUI, globalConfigDir, testLLM);
setupUI.dispose();

if (!result.ok) {
	process.exit(1);
}

// ── 初始化 ──

const { workspace, remainingArgs } = parseWorkspaceArg(
	process.argv.slice(2),
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
writeln(
	style.gray('描述你的编码任务，AI 将直接修改项目代码。输入 "exit" 退出。'),
);
writeln();

await startCodeRepl(paths, initialInput);
