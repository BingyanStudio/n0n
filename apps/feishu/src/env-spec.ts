/**
 * Feishu Bot 环境配置规格
 *
 * 声明 apps/feishu 需要的环境变量。
 * LLM 配置组根据当前 provider 动态构建，此处追加飞书专属变量。
 */

import { buildEditorLLMEnvGroup, buildLLMEnvGroup } from "@n0n/shared";
import type { EnvSpec } from "@n0n/types";

/**
 * 构建 Feishu Bot 的环境配置规格。
 */
export function buildFeishuEnvSpec(provider: string): EnvSpec {
	return {
		appName: "n0n Feishu Bot",
		groups: [
			buildLLMEnvGroup(provider),
			buildEditorLLMEnvGroup(provider),
			{
				title: "飞书应用配置",
				vars: [
					{
						key: "FEISHU_APP_ID",
						desc: "飞书应用 App ID",
						example: "cli_xxxxxxxx",
					},
					{
						key: "FEISHU_APP_SECRET",
						desc: "飞书应用 App Secret",
						example: "xxxxxxxxxxxxxxxx",
						secret: true,
					},
					{
						key: "FEISHU_ENCRYPT_KEY",
						desc: "飞书事件订阅 Encrypt Key（可选）",
						example: "xxxx",
						default: "",
					},
					{
						key: "FEISHU_DOMAIN",
						desc: "飞书域名类型（feishu / lark）",
						example: "feishu",
						default: "feishu",
					},
				],
			},
		],
	};
}

/**
 * @deprecated 使用 buildFeishuEnvSpec(provider) 替代
 */
export const feishuEnvSpec: EnvSpec = buildFeishuEnvSpec("openai");
