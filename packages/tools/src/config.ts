/**
 * Tools 配置类型
 */

import type { LLMConfig } from "@n0n/llm";

export interface ToolsConfig {
	security: {
		blockedCommands: string[];
	};
	agent: {
		defaultExecTimeout: number;
	};
	/** 工具默认工作区根目录 */
	workspace: string;
	/** 临时文件目录（exec 临时脚本等） */
	tempDir: string;
	/** Editor LLM 配置 — 用于影子编辑层 */
	editorLlm: LLMConfig;
}
