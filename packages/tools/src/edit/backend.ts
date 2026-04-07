/**
 * EditBackend — 编辑后端抽象接口
 *
 * edit.ts 负责：读文件 → 调后端 → 写文件 → 计算 diff → 返回结果。
 * 后端负责：接收源码 + 意图 → 返回修改后的内容。
 */

import type { StreamEvent } from "@n0n/types";

export interface EditBackendResult {
	content: string;
	feedback: string | null;
	error: string | null;
	rounds: number;
}

export interface EditBackendCallbacks {
	onEvent?: (round: number, event: StreamEvent) => void;
	onToolResult?: (round: number, summary: string) => void;
}

export interface EditBackend {
	readonly name: string;

	execute(
		source: string,
		intent: string,
		callbacks?: EditBackendCallbacks,
		signal?: AbortSignal,
	): Promise<EditBackendResult>;
}
