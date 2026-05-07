/**
 * 元数据与流程控制消息
 */

import type { TokenUsage } from "../client.ts";

/** submit 后的轮次反馈（系统注入），adapter 负责生成具体提示词 */
export interface TurnFeedbackMessage {
	type: "turn_feedback";
	status: "accepted" | "rejected";
	resultType: string;
	detail: string;
}

// ── 空转提示 ──
export interface IdleNudgeMessage {
	type: "idle_nudge";
	idleCount: number;
	maxIdleRounds: number;
}

// ── 缓存断点 ──
/** 显式标记提示词缓存断点位置。client 层在此处设置 cache_control，提升前缀稳定性。 */
export interface CacheBreakpointMessage {
	type: "cache_breakpoint";
}

// ── Token 用量 ──
/** LLM 调用完成后的 token 用量统计，独立于 assistant 消息的领域事件 */
export interface TokenUsageMessage {
	type: "token_usage";
	/** 本轮 LLM 调用的 token 用量 */
	usage: TokenUsage;
	/** 对应的归一化完成原因（来自 FinishReason），便于消费方区分 stop / tool_calls / length / content_filter */
	finishReason: string;
}
