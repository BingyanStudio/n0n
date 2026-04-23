/**
 * Tools 配置类型
 *
 * 使用 discriminated union 按 editBackendType 区分编辑后端配置，
 * 避免可选字段组合产生的无效状态。
 */

import type { LLMClient } from "@n0n/types";
import type { ResponsesClient } from "./edit/freeform-patch/index.ts";

interface ToolsConfigBase {
	security: {
		blockedCommands: string[];
	};
	agent: {
		defaultExecWaitfor: number;
	};
	workspace: string;
	tempDir: string;
}

interface StrReplaceToolsConfig extends ToolsConfigBase {
	editBackendType: "str-replace";
	editorClient: LLMClient;
}

interface FreeformPatchToolsConfig extends ToolsConfigBase {
	editBackendType: "freeform-patch";
	responsesClient: ResponsesClient;
}

export type ToolsConfig = StrReplaceToolsConfig | FreeformPatchToolsConfig;

export type { ResponsesClient } from "./edit/freeform-patch/index.ts";
