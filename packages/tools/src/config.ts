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
}

let _config: ToolsConfig = {
	security: { blockedCommands: [] },
	agent: { defaultExecTimeout: 120_000 },
};

export function initToolsConfig(config: ToolsConfig): void {
	_config = config;
}

export function getToolsConfig(): ToolsConfig {
	return _config;
}
