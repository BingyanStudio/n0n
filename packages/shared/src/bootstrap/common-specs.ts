/**
 * common-specs — 各 app 共享的环境变量组定义
 *
 * LLM 配置（PROVIDER / BASE_URL / API_KEY / MODEL）几乎所有 app 都需要，
 * 各 app 通过展开运算符组合共享 + 专属变量。
 *
 * 支持多 provider：
 * - openai（默认）：需要 API_KEY + MODEL，BASE_URL 可选
 * - anthropic：需要 API_KEY + MODEL，BASE_URL 可选（代理时填写）
 * - google：需要 API_KEY + MODEL，不需要 BASE_URL
 * - openai-compatible：需要 BASE_URL + API_KEY + MODEL
 */

import type { EnvGroup } from "@n0n/types";

/**
 * thinking 预算默认值的字符串表示 — 与 config.ts 中的 DEFAULT_THINKING_BUDGET_TOKENS 保持一致。
 * common-specs 是纯声明式配置，无法直接引用 @n0n/llm 常量（避免包间循环依赖），
 * 因此以注释标注 SSOT 来源。
 *
 * SSOT: packages/llm/src/config.ts → DEFAULT_THINKING_BUDGET_TOKENS
 */
const THINKING_BUDGET_DEFAULT = "1024";

/** LLM 配置组 — 所有使用 LLM 的 app 共享 */
export const LLM_ENV_GROUP: EnvGroup = {
	title: "LLM 配置",
	vars: [
		{
			key: "LLM_PROVIDER",
			desc: "LLM provider 类型（openai / anthropic / google / openai-compatible）",
			example: "openai",
			default: "openai",
		},
		{
			key: "LLM_BACKEND_PROVIDER",
			desc: "代理后端的实际 provider（仅 openai-compatible 模式下有意义，用于缓存控制）",
			example: "anthropic",
			default: "",
		},
		{
			key: "LLM_BASE_URL",
			desc: "LLM API 地址（openai-compatible 必填，anthropic 代理时填写，其他可选）",
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
		{
			key: "LLM_ENABLE_THINKING",
			desc: "启用思考模式（deepseek 等支持的模型）",
			example: "true",
			default: "false",
		},
		{
			key: "LLM_THINKING_BUDGET_TOKENS",
			desc: `思考模式的 token 预算（默认 ${THINKING_BUDGET_DEFAULT}，最低 ${THINKING_BUDGET_DEFAULT}）`,
			example: THINKING_BUDGET_DEFAULT,
			default: THINKING_BUDGET_DEFAULT,
		},
	],
};

/** Editor LLM 配置组 — 影子编辑层使用，各字段可独立 fallback 到主 LLM */
export const EDITOR_LLM_ENV_GROUP: EnvGroup = {
	title: "Editor LLM 配置（影子编辑层）",
	vars: [
		{
			key: "EDITOR_LLM_PROVIDER",
			desc: "Editor LLM provider 类型",
			example: "openai",
			inheritFrom: "LLM_PROVIDER",
		},
		{
			key: "EDITOR_LLM_BACKEND_PROVIDER",
			desc: "Editor LLM 代理后端的实际 provider",
			example: "anthropic",
			inheritFrom: "LLM_BACKEND_PROVIDER",
		},
		{
			key: "EDITOR_LLM_BASE_URL",
			desc: "Editor LLM API 地址",
			example: "https://api.openai.com",
			inheritFrom: "LLM_BASE_URL",
		},
		{
			key: "EDITOR_LLM_API_KEY",
			desc: "Editor LLM API 密钥",
			example: "sk-xxx",
			secret: true,
			inheritFrom: "LLM_API_KEY",
		},
		{
			key: "EDITOR_LLM_MODEL",
			desc: "Editor LLM 模型名称",
			example: "gpt-4o",
			inheritFrom: "LLM_MODEL",
		},
		{
			key: "EDITOR_LLM_ENABLE_THINKING",
			desc: "Editor LLM 启用思考模式",
			example: "true",
			default: "false",
			inheritFrom: "LLM_ENABLE_THINKING",
		},
		{
			key: "EDITOR_LLM_THINKING_BUDGET_TOKENS",
			desc: "Editor LLM 思考模式的 token 预算",
			example: THINKING_BUDGET_DEFAULT,
			default: THINKING_BUDGET_DEFAULT,
			inheritFrom: "LLM_THINKING_BUDGET_TOKENS",
		},
	],
};
