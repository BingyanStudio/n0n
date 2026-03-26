/**
 * Feishu Bot 环境配置规格
 *
 * 声明 apps/feishu 需要的环境变量。
 * LLM 配置组从 shared 共享，此处追加飞书专属变量。
 */

import { EDITOR_LLM_ENV_GROUP, LLM_ENV_GROUP } from "@n0n/shared";
import type { EnvSpec } from "@n0n/types";

export const feishuEnvSpec: EnvSpec = {
	appName: "n0n Feishu Bot",
	groups: [
		LLM_ENV_GROUP,
		EDITOR_LLM_ENV_GROUP,
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
