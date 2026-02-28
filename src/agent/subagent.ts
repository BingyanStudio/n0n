/**
 * subagent — 底层 agent 调用接口
 *
 * 接收 DomainMessage[] 历史和可选的 Zod schema，启动 agent loop。
 * 这是最底层的调用方式，workflow 中应优先使用 delegateTask。
 */

import type { ZodType } from "zod";
import type { DomainMessage } from "../types/domain.ts";
import type { AgentResult } from "./loop.ts";
import { agentLoop } from "./loop.ts";

export interface SubagentOptions {
	/** Zod schema 校验成功结果 */
	schema?: ZodType;
	/** 最大循环轮次 */
	maxIterations?: number;
}

/**
 * 底层 subagent 调用：给定完整的 DomainMessage[] 历史
 */
export async function subagent(
	history: DomainMessage[],
	options?: SubagentOptions,
): Promise<AgentResult> {
	return agentLoop(history, {
		maxIterations: options?.maxIterations,
		schema: options?.schema,
	});
}
