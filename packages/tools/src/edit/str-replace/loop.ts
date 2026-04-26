/**
 * Editor Loop — Editor LLM 多轮 str_replace 循环
 *
 * 使用 editorStep() 组装多轮循环，每轮委托给 step.ts 的单步执行。
 *
 * 导出：
 * - editorLoop: 完整多轮循环（供 StrReplaceBackend 使用）
 * - applySingleOp: 单次 search/replace 应用（供外部测试使用）
 * - countOccurrences, getReplacementContext: 内部工具函数
 */

import type { DomainMessage, StreamEvent, TokenUsage } from "@n0n/types";
import type { LLMClient } from "@n0n/types";
import {
  type StepInput,
  type StepResult,
  MAX_ROUNDS,
  createInitialMessages,
  editorStep,
} from "./step.ts";

// ── 外部依赖直接导出（保持兼容） ──

export { applySingleOp, countOccurrences, getReplacementContext } from "./step.ts";

// ── 结果类型 ──

export interface EditorLoopResult {
	content: string;
	feedback: string | null;
	error: string | null;
	rounds: number;
  /** 每轮的 token 用量（新增，供评估和监控使用） */
  roundTokenUsage: Array<{ round: number; usage: TokenUsage | null }>;
}

// ── Editor Loop ──

export async function editorLoop(
	source: string,
	intent: string,
	editorClient: LLMClient,
	onEvent?: (round: number, event: StreamEvent) => void,
	onToolResult?: (round: number, summary: string) => void,
	signal?: AbortSignal,
): Promise<EditorLoopResult> {
	let current = source;
	let editCount = 0;
  const messages = createInitialMessages(source, intent);
  const roundTokenUsage: Array<{ round: number; usage: TokenUsage | null }> = [];

	for (let round = 0; round < MAX_ROUNDS; round++) {
		if (signal?.aborted) {
			return {
				content: current,
				feedback: null,
				error: "Editor loop aborted",
				rounds: round,
        roundTokenUsage,
			};
		}

    const stepInput: StepInput = {
      messages,
      content: current,
      client: editorClient,
      round,
      editCount,
      signal,
      onEvent,
      onToolResult,
    };

    const result: StepResult = await editorStep(stepInput);

    // 累积 token 用量
    roundTokenUsage.push({ round, usage: result.tokenUsage });

    // 更新状态 (result.messages IS messages — already mutated in place by editorStep)
    current = result.content;
    editCount = result.totalEditCount;

    // 需要引导（模型未调用工具）：注入引导后继续循环
    if (result.needsGuidance && result.toolCalls.length === 0) {
      continue;
    }

    // 处理错误
    if (result.error) {
      return {
        content: current,
        feedback: result.feedback,
        error: result.error,
        rounds: round + 1,
        roundTokenUsage,
      };
    }

    // submit 提交则退出
    if (result.hasSubmit) {
      return {
        content: current,
        feedback: result.feedback,
        error: current !== source || editCount > 0 ? null : "No patch applied",
        rounds: round + 1,
        roundTokenUsage,
      };
    }
	}

	return {
		content: current,
		feedback: null,
		error: `Editor LLM did not submit within ${MAX_ROUNDS} rounds (${editCount} edits applied).`,
		rounds: MAX_ROUNDS,
    roundTokenUsage,
	};
}
