/**
 * Code Agent 环境配置规格
 *
 * 声明 apps/code 需要的环境变量。
 * LLM 配置组从 shared 共享，此处可追加 code 专属变量。
 */

import { EDITOR_LLM_ENV_GROUP, LLM_ENV_GROUP } from "@n0n/shared";
import type { EnvSpec } from "@n0n/types";

export const codeEnvSpec: EnvSpec = {
	appName: "n0n Code Agent",
	groups: [
		LLM_ENV_GROUP,
		EDITOR_LLM_ENV_GROUP,
		{
			title: "安全配置",
			vars: [
				{
					key: "BLOCKED_COMMANDS",
					desc: "禁止执行的命令（逗号分隔）",
					example: "rm -rf /,shutdown",
					default: "",
				},
			],
		},
	],
};
