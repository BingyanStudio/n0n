/**
 * Code Agent — 入口
 *
 * 代码编写场景的 agent，产出物为项目代码变更（而非 workflow）。
 * 默认以 cwd 为工作区（终端启动），macOS 双击时 fallback 到脚本所在目录。
 * 也可通过 --workspace 指定其他目录。
 *
 * 启动流程：
 * 1. bootstrap — 检测 .env / 必填配置 / LLM 连通性，缺什么补什么
 * 2. 初始化运行时上下文
 * 3. 启动 REPL
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { CliSetupRenderer, style, writeln } from "@n0n/cli-ui";
import { createRuntimeContext, initRuntime } from "@n0n/core";
import {
	buildLLMConfigFromEnv,
	createLLMClient,
	createResponsesClient,
} from "@n0n/llm";
import {
	bootstrap,
	ensureDirs,
	parseWorkspaceArg,
	resolveBasePaths,
} from "@n0n/shared";

import { buildCodeEnvSpec } from "./env-spec.ts";

// ── Bootstrap ──
// 配置文件存放在全局目录 ~/.n0n/，避免每个工作目录都需要重新配置
const globalConfigDir = resolve(homedir(), ".n0n");
if (!existsSync(globalConfigDir)) {
	mkdirSync(globalConfigDir, { recursive: true });
}

const setupUI = new CliSetupRenderer();

/** LLM 连通性测试回调 — 注入到 bootstrap，避免 shared 直接依赖 llm */
const testLLM = async () => {
	const llmConfig = buildLLMConfigFromEnv("LLM");
	const tempClient = createLLMClient(llmConfig);
	return tempClient.ping();
};

const result = await bootstrap(
	buildCodeEnvSpec,
	setupUI,
	globalConfigDir,
	testLLM,
);
setupUI.dispose();

if (!result.ok) {
	process.exit(1);
}

// ── 初始化 ──

const cliOpts = (globalThis as Record<string, unknown>).__n0n_cli_opts as
	| {
			resumeFile?: string;
			saveEveryLoop?: boolean;
			promptVersion?: string;
			filteredArgs?: string[];
		}
	| undefined;
const resumeFile = cliOpts?.resumeFile;
const saveEveryLoop = cliOpts?.saveEveryLoop ?? false;
const promptVersion = cliOpts?.promptVersion;

const { workspace, remainingArgs } = parseWorkspaceArg(
	cliOpts?.filteredArgs ?? process.argv.slice(2),
	"N0N_CODE_WORKSPACE",
	// macOS 双击打开时 cwd 为 home 目录，此时 fallback 到脚本所在目录
	process.cwd() === homedir()
		? dirname(resolve(process.argv[1] ?? "."))
		: process.cwd(),
);

const paths = resolveBasePaths(workspace);
ensureDirs(paths);
const llmConfig = buildLLMConfigFromEnv("LLM");

// 编辑后端：通过 EDIT_BACKEND 环境变量切换，默认 str-replace
const editBackendType =
	process.env.EDIT_BACKEND === "freeform-patch"
		? "freeform-patch"
		: "str-replace";

const runtime =
	editBackendType === "freeform-patch"
		? createRuntimeContext({
				client: createLLMClient(llmConfig),
				editBackend: {
					type: "freeform-patch",
					responsesClient: createResponsesClient({
						baseUrl:
							process.env.EDITOR_LLM_BASE_URL || process.env.LLM_BASE_URL || "",
						apiKey:
							process.env.EDITOR_LLM_API_KEY || process.env.LLM_API_KEY || "",
						model: process.env.EDITOR_LLM_MODEL || "gpt-5.4-mini",
					}),
				},
			})
		: createRuntimeContext({
				client: createLLMClient(llmConfig),
				editBackend: {
					type: "str-replace",
					editorClient: createLLMClient(
						buildLLMConfigFromEnv("EDITOR_LLM", llmConfig.providerConfig),
					),
				},
			});
initRuntime(runtime);

const { startCodeRepl } = await import("./repl.ts");

const initialInput =
	remainingArgs.length > 0 ? remainingArgs.join(" ") : undefined;

// 提示词版本信息
const versionNote = promptVersion ? ` [提示词 v${promptVersion}]` : "";

writeln(
	style.bold("n0n code") +
		style.gray(` — Code Agent [${paths.workspace}]${versionNote}`),
);
writeln(
	style.gray('描述你的编码任务，AI 将直接修改项目代码。输入 "exit" 退出。'),
);
writeln(style.gray("支持多行输入 / 粘贴，按空行（回车）提交。"));
writeln();

await startCodeRepl(paths, {
	initialInput,
	resumeFile,
	saveEveryLoop,
	promptVersion,
});
process.exit(0);
