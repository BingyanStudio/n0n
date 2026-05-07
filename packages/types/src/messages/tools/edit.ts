/**
 * Edit 工具结果类型
 */

import type { MakeResultBase } from "./registry.ts";

/** 单个补丁操作 */
export interface PatchOp {
	/** 旧文本（将被替换掉的内容） */
	oldText: string;
	/** 新文本（替换后的内容） */
	newText: string;
}

export type EditToolResult = MakeResultBase<"edit"> & {
	patches: PatchOp[];
	success: boolean;
	error: string | null;
	/** Editor LLM 对主模型编辑指令的反馈（过度指定/任务过大/过于模糊等），null 表示指令清晰 */
	feedback: string | null;
	/** Editor LLM 循环轮次数 */
	rounds: number;
	/** 编辑总耗时（毫秒） */
	durationMs: number;
};
