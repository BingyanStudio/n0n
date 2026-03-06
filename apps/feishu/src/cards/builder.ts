/**
 * 飞书卡片构建器
 *
 * 核心设计：按轮次分块展示，每个 round 是一个折叠面板。
 * 最新 round 展开，历史 round 折叠，建立清晰的因果层级。
 *
 * 布局结构：
 * ┌─ n0n · round 2/30 ─────── [grey] ─┐
 * │                                     │
 * │  ▸ Round 1  (collapsed)             │
 * │                                     │
 * │  ▾ Round 2  (expanded)              │
 * │  │ thinking…                        │
 * │  │ ▸ exec  command=ls               │
 * │  │ ◂ exec → exit=0 0.3s            │
 * │  │ response text…                   │
 * │  ──────────────────────             │
 * │  ✔ 任务完成: …                       │
 * └─────────────────────────────────────┘
 */

import type {
	CardBodyElement,
	CardHeaderTemplate,
	CollapsiblePanelElement,
	FeishuCardContent,
	MarkdownElement,
} from "./types.ts";

// ── 基础 ──

function norm(s: string): string {
	return s.trim() || "(empty)";
}

function md(s: string): MarkdownElement {
	return { tag: "markdown", content: norm(s) };
}

function mkCard(
	title: string,
	tpl: CardHeaderTemplate,
	elements: CardBodyElement[],
): FeishuCardContent {
	return {
		schema: "2.0",
		config: { wide_screen_mode: true, enable_forward: true },
		header: { template: tpl, title: { tag: "plain_text", content: title } },
		body: { elements },
	};
}

function mkPanel(
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
	tpl: CardHeaderTemplate = "blue",
): FeishuCardContent {
	return mkCard(title, tpl, [md(text)]);
}

// ── 轮次数据模型 ──

/** 轮次内的单条日志 */
export interface LogLine {
	/** 前缀符号控制缩进和语义 */
	prefix: "│" | "▸" | "◂" | "✗" | "·" | "✔";
	text: string;
}

/** 一个完整轮次的数据 */
export interface RoundBlock {
	/** 轮次标题，如 "Round 1 · 2 msgs" */
	title: string;
	/** 轮次内的日志行 */
	lines: LogLine[];
	/** 是否正在进行中 */
	active?: boolean;
}

/** 将 RoundBlock 渲染为折叠面板内的 markdown */
function renderRoundMarkdown(block: RoundBlock): string {
	if (block.lines.length === 0) return "...";
	return block.lines.map((l) => `${l.prefix}  ${l.text}`).join("\n");
}

/**
 * 构建过程卡片 — 按轮次分块
 *
 * 每个 round 是一个折叠面板：
 * - 最新（active）round 展开
 * - 历史 round 折叠
 * - 底部可选 activity（流式状态）和 summary（最终结果）
 */
export function buildProcessCard(opts: {
	title: string;
	template?: CardHeaderTemplate;
	rounds: RoundBlock[];
	activity?: string;
	summary?: string;
}): FeishuCardContent {
	const elements: CardBodyElement[] = [];

	for (const [i, block] of opts.rounds.entries()) {
		const isLast = i === opts.rounds.length - 1;
		const expanded = isLast && (block.active ?? true);
		elements.push(mkPanel(block.title, renderRoundMarkdown(block), expanded));
	}

	// 流式活动状态
	if (opts.activity) {
		elements.push(md(opts.activity));
	}

	// 最终总结
	if (opts.summary) {
		elements.push({ tag: "hr" });
		elements.push(md(opts.summary));
	}

	if (elements.length === 0) {
		elements.push(md("初始化..."));
	}

	return mkCard(opts.title, opts.template ?? "grey", elements);
}

// ── 工具 ──

export function chunkText(text: string, size: number): string[] {
	if (text.length <= size) return [text];
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) {
		chunks.push(text.slice(i, i + size));
	}
	return chunks;
}
