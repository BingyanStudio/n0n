/**
 * 飞书卡片构建器
 *
 * 设计原则：沉稳、信息分层、因果清晰。
 * 参考 CLI RichRenderer 的排版风格：
 * - 用符号（▸ ◂ │ ─）代替花哨 emoji 建立视觉层次
 * - 信息密度高，通过缩进和分隔线区分层级
 * - 折叠面板收纳详情，主视图保持简洁
 */

import type {
	CardBodyElement,
	CardHeaderTemplate,
	CollapsiblePanelElement,
	FeishuCardContent,
	MarkdownElement,
} from "./types.ts";

// ── 基础构建 ──

function norm(content: string): string {
	return content.trim() || "(empty)";
}

function md(content: string): MarkdownElement {
	return { tag: "markdown", content: norm(content) };
}

function card(
	title: string,
	template: CardHeaderTemplate,
	elements: CardBodyElement[],
): FeishuCardContent {
	return {
		schema: "2.0",
		config: { wide_screen_mode: true, enable_forward: true },
		header: { template, title: { tag: "plain_text", content: title } },
		body: { elements },
	};
}

export function mkCollapsiblePanel(
	title: string,
	markdown: string,
	expanded = false,
): CollapsiblePanelElement {
	return {
		tag: "collapsible_panel",
		expanded,
		header: {
			title: { tag: "plain_text", content: title },
			icon: {
				tag: "standard_icon",
				token: "down-small-ccm_outlined",
				size: "16px 16px",
			},
			icon_position: "right",
			icon_expanded_angle: -180,
		},
		vertical_spacing: "8px",
		padding: "8px 8px 8px 8px",
		elements: [md(markdown)],
	};
}

// ── 简单文本卡片 ──

export function buildTextCard(
	title: string,
	text: string,
	template: CardHeaderTemplate = "blue",
): FeishuCardContent {
	return card(title, template, [md(text)]);
}

// ── 日志条目类型 ──

export type LogEntryKind =
	| "round"
	| "thinking"
	| "content"
	| "tool_start"
	| "tool_end"
	| "tool_error"
	| "info"
	| "result_ok"
	| "result_err";

export interface LogEntry {
	kind: LogEntryKind;
	text: string;
	/** 可折叠的详情内容 */
	detail?: string;
}

/** 将 LogEntry 渲染为单行 markdown */
function renderLogLine(entry: LogEntry): string {
	switch (entry.kind) {
		case "round":
			return `**${entry.text}**`;
		case "thinking":
			return `  │ ${entry.text}`;
		case "content":
			return `  ${entry.text}`;
		case "tool_start":
			return `  ▸ ${entry.text}`;
		case "tool_end":
			return `  ◂ ${entry.text}`;
		case "tool_error":
			return `  ✗ ${entry.text}`;
		case "info":
			return `  · ${entry.text}`;
		case "result_ok":
			return `**✔ ${entry.text}**`;
		case "result_err":
			return `**✗ ${entry.text}**`;
	}
}

// ── 过程卡片（核心：流式显示用） ──

/**
 * 构建过程卡片 — 模仿 CLI 的信息流排版
 *
 * 布局：
 * - Header: 灰色（工作中）或彩色（完成）
 * - 主体: 日志流（每行一个事件，用符号区分类型）
 * - 折叠面板: 工具调用详情（输入/输出）
 * - 底部: 当前活动 或 最终总结
 */
export function buildProcessCard(opts: {
	title: string;
	template?: CardHeaderTemplate;
	logs: LogEntry[];
	activity?: string;
	summary?: string;
}): FeishuCardContent {
	const elements: CardBodyElement[] = [];

	// 日志流：主体信息
	if (opts.logs.length > 0) {
		const lines = opts.logs.map(renderLogLine).join("\n");
		elements.push(md(lines));
	}

	// 折叠详情面板（仅展示有 detail 的条目）
	const detailed = opts.logs.filter((e) => e.detail);
	if (detailed.length > 0) {
		for (const entry of detailed) {
			const prefix =
				entry.kind === "tool_start"
					? "▸"
					: entry.kind === "tool_end"
						? "◂"
						: "·";
			elements.push(
				mkCollapsiblePanel(
					`${prefix} ${entry.text}`,
					entry.detail ?? "",
					false,
				),
			);
		}
	}

	// 当前活动（流式状态）
	if (opts.activity) {
		elements.push({ tag: "hr" });
		elements.push(md(opts.activity));
	}

	// 最终总结
	if (opts.summary) {
		elements.push({ tag: "hr" });
		elements.push(md(opts.summary));
	}

	return card(
		opts.title,
		opts.template ?? "grey",
		elements.length > 0 ? elements : [md("...")],
	);
}

// ── 文本分块工具 ──

export function chunkText(text: string, size: number): string[] {
	if (text.length <= size) return [text];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) {
		chunks.push(text.slice(i, i + size));
	}
	return chunks;
}
