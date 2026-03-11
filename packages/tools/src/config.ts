/**
 * Tools 配置类型
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
