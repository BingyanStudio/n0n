/**
 * StrReplaceBackend — Editor LLM 多轮 str_replace 循环
 *
 * 包装 editorLoop，适配 EditBackend 接口。
 * 默认后端：通过 LLMClient 驱动 Editor LLM 进行精确文本替换。
 */

import type { LLMClient } from "@n0n/types";
import type {
	EditBackend,
	EditBackendCallbacks,
	EditBackendResult,
} from "../backend.ts";
import { editorLoop } from "./loop.ts";

export { applySingleOp, editorLoop } from "./loop.ts";

export class StrReplaceBackend implements EditBackend {
	readonly name = "str-replace";
	private readonly client: LLMClient;

	constructor(client: LLMClient) {
		this.client = client;
	}

	async execute(
		source: string,
		intent: string,
		callbacks?: EditBackendCallbacks,
		signal?: AbortSignal,
	): Promise<EditBackendResult> {
		return editorLoop(
			source,
			intent,
			this.client,
			callbacks?.onEvent,
			callbacks?.onToolResult,
			signal,
		);
	}
}
