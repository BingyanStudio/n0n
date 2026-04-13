/**
 * common-specs — 各 app 共享的环境变量组定义
 *
 * LLM 配置变量按 provider 动态组装：
 * - 基础变量（PROVIDER / BASE_URL / API_KEY / MODEL）所有 provider 都需要
 * - 行为变量按 provider 类型追加（如 Anthropic 的 THINKING_BUDGET_TOKENS）
 *
 * 各 app 通过 buildLLMEnvGroups(provider) 获取当前 provider 的完整配置组，
 * 无需知道各 provider 的参数细节。
 */

import type { EnvGroup, EnvVarDef } from "@n0n/types";

// ── 基础变量（所有 provider） ──

const LLM_BASE_VARS: EnvVarDef[] = [
	{
		key: "LLM_PROVIDER",
		desc: "LLM provider 类型（openai / anthropic / google / openai-compatible）",
		example: "openai",
		default: "openai",
	},
	{
		key: "LLM_BASE_URL",
		desc: "LLM API 地址",
		example: "https://api.openai.com",
		default: "",
	},
	{
		key: "LLM_API_KEY",
		desc: "LLM API 密钥",
		example: "sk-xxx",
		secret: true,
	},
	{
		key: "LLM_MODEL",
		desc: "模型名称",
		example: "gpt-4o",
	},
];

// ── Provider-specific 变量 ──

const ANTHROPIC_VARS: EnvVarDef[] = [
	{
		key: "LLM_ENABLE_THINKING",
		desc: "启用思考模式（也可通过设置 THINKING_BUDGET_TOKENS 启用）",
		example: "true",
		default: "false",
	},
	{
		key: "LLM_THINKING_BUDGET_TOKENS",
		desc: "思考 token 预算（设置即启用思考，默认 1024）",
		example: "1024",
		default: "",
	},
];

const GOOGLE_VARS: EnvVarDef[] = [
	{
		key: "LLM_THINKING_EFFORT",
		desc: "思考强度（low / medium / high，默认 high）",
		example: "high",
		default: "high",
	},
];

const OPENAI_COMPATIBLE_VARS: EnvVarDef[] = [
	{
		key: "LLM_BACKEND_PROVIDER",
		desc: "代理后端的实际 provider（用于缓存控制透传）",
		example: "anthropic",
		default: "",
	},
	{
		key: "LLM_ENABLE_THINKING",
		desc: "启用思考模式（国产模型 enable_thinking flag）",
		example: "true",
		default: "false",
	},
];

// ── 动态构建 ──

/**
 * 根据 provider 类型构建 LLM 配置环境变量组。
 *
 * 只包含当前 provider 有意义的变量，
 * 用户不会看到与自己 provider 无关的配置项。
 */
export function buildLLMEnvGroup(provider: string): EnvGroup {
	const vars = [...LLM_BASE_VARS];
	switch (provider) {
		case "anthropic":
			vars.push(...ANTHROPIC_VARS);
			break;
		case "google":
			vars.push(...GOOGLE_VARS);
			break;
		case "openai-compatible":
			vars.push(...OPENAI_COMPATIBLE_VARS);
			break;
		// openai: 无额外变量
	}
	return { title: "LLM 配置", vars };
}

/**
 * 根据 provider 类型构建 Editor LLM 配置环境变量组。
 *
 * 各字段可独立 fallback 到主 LLM 配置。
 */
export function buildEditorLLMEnvGroup(provider: string): EnvGroup {
	const mainGroup = buildLLMEnvGroup(provider);
	const vars: EnvVarDef[] = mainGroup.vars.map((v) => {
		// 继承变量不保留 default——让 inheritFrom 机制生效
		const { default: _, ...rest } = v;
		return {
			...rest,
			key: `EDITOR_${v.key}`,
			desc: `Editor ${v.desc}`,
			inheritFrom: v.key,
		};
	});
	return { title: "Editor LLM 配置（影子编辑层）", vars };
}
