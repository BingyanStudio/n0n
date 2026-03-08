/**
 * Tools 配置 — 由调用方注入
 */

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
}

let _config: ToolsConfig = {
	security: { blockedCommands: [] },
	agent: { defaultExecTimeout: 120_000 },
	workspace: process.cwd(),
	tempDir: ".temp",
};

export function initToolsConfig(config: ToolsConfig): void {
	_config = config;
}

export function getToolsConfig(): ToolsConfig {
	return _config;
}
