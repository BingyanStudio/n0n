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

import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

import { codeEnvSpec } from "./env-spec.ts";

/**
 * 配置前缀切换 — N0N_PREFIX=XXX 时，将 XXX_LLM_* 覆盖到 LLM_*，XXX_EDITOR_LLM_* 覆盖到 EDITOR_LLM_*
 * 
 * 支持在 .env 中定义多组配置，通过修改 N0N_PREFIX 快速切换，免去反复注释的麻烦。
 */
function applyConfigPrefix(configDir: string): void {
	// 解析全局 .env（此时 bootstrap 尚未加载它，需要手动读取）
	const globalEnvPath = resolve(configDir, ".env");
	let globalVars: Record<string, string> = {};
	if (existsSync(globalEnvPath)) {
		const content = readFileSync(globalEnvPath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIdx = trimmed.indexOf("=");
			if (eqIdx < 0) continue;
			const key = trimmed.slice(0, eqIdx).trim();
			const value = trimmed.slice(eqIdx + 1).trim();
			if (key) globalVars[key] = value;
		}
	}

	const prefix = process.env.N0N_PREFIX || globalVars.N0N_PREFIX;
	if (!prefix) return;

	const standardKeys = [
		"LLM_PROVIDER", "LLM_BACKEND_PROVIDER", "LLM_BASE_URL",
		"LLM_API_KEY", "LLM_MODEL", "LLM_ENABLE_THINKING", "LLM_THINKING_BUDGET_TOKENS",
		"EDITOR_LLM_PROVIDER", "EDITOR_LLM_BACKEND_PROVIDER", "EDITOR_LLM_BASE_URL",
		"EDITOR_LLM_API_KEY", "EDITOR_LLM_MODEL", "EDITOR_LLM_ENABLE_THINKING",
		"EDITOR_LLM_THINKING_BUDGET_TOKENS",
		"EDIT_BACKEND",
	];

	for (const key of standardKeys) {
		const prefixedKey = `${prefix}_${key}`;
		const value = process.env[prefixedKey] ?? globalVars[prefixedKey];
		if (value !== undefined) {
			process.env[key] = value;
		}
	}
}

// ── Bootstrap ──
// 配置文件存放在全局目录 ~/.n0n/，避免每个工作目录都需要重新配置
const globalConfigDir = resolve(homedir(), ".n0n");
if (!existsSync(globalConfigDir)) {
	mkdirSync(globalConfigDir, { recursive: true });
}

applyConfigPrefix(globalConfigDir);

const setupUI = new CliSetupRenderer();

/** LLM 连通性测试回调 — 注入到 bootstrap，避免 shared 直接依赖 llm */
const testLLM = async () => {
	try {
		const config = buildLLMConfigFromEnv("LLM");
		const client = createLLMClient(config);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		try {
			// 流式调用 — 收到首个有效事件即判定连接正常，立即中断节省 token
			for await (const event of client.stream(
				{ messages: [{ type: "user_text", content: "hi" }] },
				controller.signal,
			)) {
				if (event.type === "error") {
					return { ok: false as const, error: event.error };
				}
				// 任何非 error 事件 → 连接正常，中断流
				controller.abort();
				break;
			}
		} finally {
			clearTimeout(timeout);
		}
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

const cliOpts = (globalThis as Record<string, unknown>).__n0n_cli_opts as
	| { resumeFile?: string; saveEveryLoop?: boolean; filteredArgs?: string[] }
	| undefined;
const resumeFile = cliOpts?.resumeFile;
const saveEveryLoop = cliOpts?.saveEveryLoop ?? false;

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
							process.env.EDITOR_LLM_BASE_URL ||
							process.env.LLM_BASE_URL ||
							"",
						apiKey:
							process.env.EDITOR_LLM_API_KEY ||
							process.env.LLM_API_KEY ||
							"",
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

writeln(
	style.bold("n0n code") + style.gray(` — Code Agent [${paths.workspace}]`),
);
writeln(
	style.gray('描述你的编码任务，AI 将直接修改项目代码。输入 "exit" 退出。'),
);
writeln(style.gray("支持多行输入 / 粘贴，按空行（回车）提交。"));
writeln();

await startCodeRepl(paths, { initialInput, resumeFile, saveEveryLoop });
