/**
 * Write 工具结果类型
 */

import type { MakeResult } from "./registry.ts";

/** write 正常写入成功 */
export interface WriteCompleted extends MakeResult<"write", "completed"> {}

/** write 写入失败 */
export interface WriteFailed extends MakeResult<"write", "failed"> {
	error: string;
}

/** write 从截断恢复后写入成功（内容不完整） */
export interface WriteRecovered extends MakeResult<"write", "recovered"> {}

/** write 从截断恢复失败（参数无法解析） */
export interface WriteRecoverFailed
	extends MakeResult<"write", "recover_failed"> {
	error: string;
}

export type WriteToolResult =
	| WriteCompleted
	| WriteFailed
	| WriteRecovered
	| WriteRecoverFailed;
