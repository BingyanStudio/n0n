/**
 * DeepSeek directive 拦截与注入
 *
 * CollectingTagAdapter 在 formatPrompt 阶段拦截控制性 tag，
 * injectDirectives 在消息序列构建完成后将收集到的 directive
 * 集中追加到序列末尾，避免破坏 tool_calls→tool_result 连续性。
 */

import type { TagAdapter } from "@n0n/types";
import type { DeepSeekMessage } from "./formatter.ts";

// ── 控制性 Tag 集合 ──

/**
 * 控制性 tag — wrapTag 时拦截这些 tag 的内容，
 * 从消息正文中剥离，后续转为 developer 消息。
 *
 * A 类（整条消息都是控制性内容）：
 *   system_warning, progress_rejected, turn_feedback
 * B 类（嵌在 user_input 中的控制性片段）：
 *   hint
 * C 类（嵌在 tool result 中的辅助提示）：
 *   edit_feedback, diagnostic_hint, output_hint
 */
export const DIRECTIVE_TAGS = new Set([
	"hint",
	"system_warning",
	"progress_rejected",
	"turn_feedback",
	"edit_feedback",
	"diagnostic_hint",
	"output_hint",
]);

export interface CollectedDirective {
	tag: string;
	content: string;
}

export const DIRECTIVE_PLACEHOLDER_RE = /🔮⟪DIR:(\d+)⟫🔮/g;

// ── CollectingTagAdapter ──

/**
 * 带 sideband 收集的 TagAdapter — DeepSeek 专用。
 *
 * wrapTag 时检查 tag name：
 * - 控制性 tag → 存入 collected，返回占位符
 * - 数据性 tag → 正常返回标准 XML 包裹内容
 *
 * 每次 stream() 调用新建一个实例。
 */
export class DeepSeekCollectingAdapter implements TagAdapter {
	private readonly base: TagAdapter;
	private readonly collected: CollectedDirective[] = [];

	constructor(base: TagAdapter) {
		this.base = base;
	}

	wrapTag(name: string, content: string): string {
		if (DIRECTIVE_TAGS.has(name)) {
			const idx = this.collected.length;
			this.collected.push({ tag: name, content });
			return `🔮⟪DIR:${idx}⟫🔮`;
		}
		return this.base.wrapTag(name, content);
	}

	adaptTags(text: string): string {
		return this.base.adaptTags(text);
	}

	/** 返回收集到的全部控制性内容 */
	directives(): readonly CollectedDirective[] {
		return this.collected;
	}
}

// ── Directive 注入 ──

/**
 * 扫描消息 content 中的占位符，将控制性 directive 集中追加到序列末尾。
 *
 * 策略（与 format.py 的 _drop_thinking_messages 等效）：
 * - 找到最后一个 assistant 消息 G
 * - G 及其之前的占位符：从 content 中移除，directive 丢弃（历史 directive 已过时）
 * - G 之后的占位符：从 content 中移除，directive 收集起来
 * - 收集到的 directive 统一追加到序列末尾作为 developer 消息
 *
 * 这样做确保 developer 消息不会插入 assistant(tool_calls)→tool(result) 之间，
 * 避免 DeepSeek API "insufficient tool messages following tool_calls" 错误。
 */
export function injectDirectives(
	messages: DeepSeekMessage[],
	directives: readonly CollectedDirective[],
): DeepSeekMessage[] {
	if (directives.length === 0) return messages;

	// 找最后一个 assistant 消息的索引 G
	let lastAssistantIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "assistant") {
			lastAssistantIdx = i;
			break;
		}
	}

	const result: DeepSeekMessage[] = [];
	const collected: CollectedDirective[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!;
		const content = msg.content ?? "";

		if (!DIRECTIVE_PLACEHOLDER_RE.test(content)) {
			DIRECTIVE_PLACEHOLDER_RE.lastIndex = 0;
			result.push(msg);
			continue;
		}
		DIRECTIVE_PLACEHOLDER_RE.lastIndex = 0;

		const found: CollectedDirective[] = [];
		const cleaned = content
			.replace(DIRECTIVE_PLACEHOLDER_RE, (_, idxStr) => {
				const d = directives[Number(idxStr)];
				if (d) found.push(d);
				return "";
			})
			.trim();

		if (cleaned) {
			result.push({ ...msg, role: msg.role, content: cleaned });
		}

		// G 之后的 directive 收集到末尾；G 及之前的丢弃
		if (i > lastAssistantIdx) {
			collected.push(...found);
		}
	}

	// 末尾追加收集到的 directive
	for (const d of collected) {
		result.push({
			role: "developer",
			content: d.content,
		});
	}

	return result;
}
