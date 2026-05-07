/**
 * Progress 工具结果类型
 */

import type { MakeResultBase } from "./registry.ts";

export type ProgressToolResult = MakeResultBase<"progress"> & {
	/** progress 的结果值（等于 call.args，由 schema 后验证） */
	cleanedResult: unknown;
	/** 用户对 progress 结果的回应（由 REPL 注入，非模型生成） */
	userResponse?: string;
};
