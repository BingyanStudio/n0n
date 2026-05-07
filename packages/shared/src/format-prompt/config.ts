import type { DomainMessage } from "@n0n/types";

type MessageType = DomainMessage["type"];

/**
 * 每种 DomainMessage 是否参与 msgIndex 计数。
 *
 * msgIndex 用于 anti-few-shot 模板选择——只有产生实际 PromptMessage
 * 输出的消息才应参与计数。不产生输出的消息参与计数会导致：
 * 该消息插入/移除 → 后续所有消息的 msgIndex 偏移 → 模板选择变化 →
 * 格式化内容变化 → Anthropic prompt cache 失效。
 */
export const AFFECTS_SUBSEQUENT: Record<MessageType, boolean> = {
	system: true,
	generic_user_text: true,
	generic_tool_call: true,
	generic_tool_result: true,
	user_input: true,
	user_image: true,
	assistant_text: true,
	assistant_tool_call: true,
	tool_result: true,
	idle_nudge: true,
	turn_feedback: true,
	tool_arg_error: true,
	cache_breakpoint: false,
	token_usage: false,  // 不产生提示词输出，不参与 msgIndex 计数（与 cache_breakpoint 同理）
};

/** 判断给定消息类型是否影响后续消息的 msgIndex 计数 */
export function affectsSubsequent(type: MessageType): boolean {
	return AFFECTS_SUBSEQUENT[type];
}
