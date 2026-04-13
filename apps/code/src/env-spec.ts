/**
 * Code Agent 环境配置规格
 *
 * 声明 apps/code 需要的环境变量。
 * LLM 配置组根据当前 provider 动态构建，此处追加 code 专属变量。
 */

import {
	buildEditorLLMEnvGroup,
	buildLLMEnvGroup,
} from "@n0n/shared";
import type { EnvSpec } from "@n0n/types";

/**
 * 构建 Code Agent 的环境配置规格。
 *
 * provider 参数决定显示哪些 LLM 行为变量——
 * 用户只会看到与自己 provider 相关的配置项。
 */
export function buildCodeEnvSpec(provider: string): EnvSpec {
	return {
		appName: "n0n Code Agent",
		groups: [
			buildLLMEnvGroup(provider),
			buildEditorLLMEnvGroup(provider),
			{
				title: "编辑后端",
				vars: [
					{
						key: "EDIT_BACKEND",
						desc: "编辑后端类型",
						example: "freeform-patch",
						default: "str-replace",
					},
				],
			},
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
			{
				title: "提示音",
				vars: [
					{
						key: "N0N_NOTIFY_SOUND",
						desc: "Submit 完成后播放提示音（1 或 true 开启）",
						example: "1",
						default: "",
					},
					{
						key: "N0N_NOTIFY_SOUND_PATH",
						desc: "自定义提示音文件路径（WAV 格式），留空使用内置电子音",
						example: "/path/to/notify.wav",
						default: "",
					},
				],
			},
		],
	};
}
