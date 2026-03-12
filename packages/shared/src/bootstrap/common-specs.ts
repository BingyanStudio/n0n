/**
 * common-specs — 各 app 共享的环境变量组定义
 *
 * LLM 三件套（BASE_URL / API_KEY / MODEL）几乎所有 app 都需要，
 * 各 app 通过展开运算符组合共享 + 专属变量。
 */

import type { EnvGroup } from "@n0n/types";

/** LLM 配置组 — 所有使用 LLM 的 app 共享 */
export const LLM_ENV_GROUP: EnvGroup = {
	title: "LLM 配置",
	vars: [
		{
			key: "LLM_BASE_URL",
			desc: "LLM API 地址（OpenAI 兼容接口）",
			example: "https://api.openai.com",
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
	],
};
