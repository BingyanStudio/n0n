/**
 * 全局配置 — 从环境变量读取，初始化所有子包配置
 */

import { resolve } from "node:path";
import { initLLMConfig } from "@n0n/llm";
import { initToolsConfig } from "@n0n/tools";

function requireEnv(key: string): string {
	const val = process.env[key];
	if (!val) throw new Error(`Missing required env: ${key}`);
	return val;
}

function parseBlockedCommands(): string[] {
	const raw = process.env.BLOCKED_COMMANDS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((c) => c.trim())
		.filter((c) => c.length > 0);
}

/**
 * 工作区路径集合 — 所有路径均为绝对路径。
 */
export interface WorkspacePaths {
	workspace: string;
	workflows: string;
	tasks: string;
	skills: string;
	schedules: string;
	memory: string;
	consultResult: string;
	history: string;
	temp: string;
}

/**
 * 路径配置输入 — 所有字段可选，未指定的使用默认值。
 * workspace 默认为 process.cwd()，其余路径相对于 workspace 解析。
 */
export interface PathConfig {
	workspace?: string;
	workflows?: string;
	tasks?: string;
	skills?: string;
	schedules?: string;
	memory?: string;
	consultResult?: string;
	history?: string;
	temp?: string;
}

/**
 * 解析工作区路径 — 纯函数，无副作用。
 * 所有子目录路径相对于 workspace 解析。
 */
export function resolvePaths(pathConfig: PathConfig = {}): WorkspacePaths {
	const workspace = resolve(pathConfig.workspace ?? process.cwd());
	return {
		workspace,
		workflows: resolve(workspace, pathConfig.workflows ?? "workflows"),
		tasks: resolve(workspace, pathConfig.tasks ?? "workflows/tasks"),
		skills: resolve(workspace, pathConfig.skills ?? "workflows/skills"),
		schedules: resolve(
			workspace,
			pathConfig.schedules ?? "workflows/schedules",
		),
		memory: resolve(workspace, pathConfig.memory ?? "workflows/memory"),
		consultResult: resolve(
			workspace,
			pathConfig.consultResult ?? "workflows/consult-result",
		),
		history: resolve(workspace, pathConfig.history ?? "workflows/history"),
		temp: resolve(workspace, pathConfig.temp ?? ".temp"),
	};
}

/** 最近一次 initConfig 设置的路径 */
let _currentPaths: WorkspacePaths = resolvePaths();

/**
 * 获取当前全局配置对应的工作区路径。
 * 返回最近一次 `initConfig()` 调用后的路径。
 */
export function getCurrentPaths(): WorkspacePaths {
	return _currentPaths;
}

export const config = {
	llm: {
		baseUrl: requireEnv("LLM_BASE_URL"),
		apiKey: requireEnv("LLM_API_KEY"),
		model: requireEnv("LLM_MODEL"),
		enableThinking: process.env.LLM_ENABLE_THINKING === "true",
	},
	agent: {
		maxIterations: 50,
		maxIdleRounds: 5,
		defaultExecTimeout: 120_000,
	},
	security: {
		blockedCommands: parseBlockedCommands(),
	},
} as const;

/**
 * 初始化所有子包配置（应用启动时调用一次）。
 */
export function initConfig(pathConfig: PathConfig = {}): WorkspacePaths {
	const resolvedPaths = resolvePaths(pathConfig);
	_currentPaths = resolvedPaths;
	initLLMConfig(config.llm);
	initToolsConfig({
		security: config.security,
		agent: config.agent,
		workspace: resolvedPaths.workspace,
		tempDir: resolvedPaths.temp,
	});
	return resolvedPaths;
}

// 自动初始化（使用 process.cwd() 默认值，app 层会再次调用 initConfig 覆盖）
initConfig();
