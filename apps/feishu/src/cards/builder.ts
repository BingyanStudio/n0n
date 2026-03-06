/**
 * 飞书卡片构建器
 *
 * 提供各种卡片模板的构建函数，将业务数据转换为飞书卡片 JSON。
 * 所有卡片使用 Interactive Card v2.0 schema。
 */

import type {
	CardBodyElement,
	CardHeaderTemplate,
	CollapsiblePanelElement,
	FeishuCardContent,
	MarkdownElement,
} from "./types.ts";

// ── 基础构建 ──

function normalizeMarkdown(content: string): string {
	return content.trim() || "(empty)";
}

function mkMarkdown(content: string): MarkdownElement {
	return { tag: "markdown", content: normalizeMarkdown(content) };
}

function mkCard(
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
		elements: [mkMarkdown(markdown)],
	};
}

// ── 简单文本卡片 ──

export function buildTextCard(
	title: string,
	text: string,
	template: CardHeaderTemplate = "blue",
): FeishuCardContent {
	return mkCard(title, template, [mkMarkdown(text)]);
}

// ── 步骤流卡片（核心：流式显示用） ──

export interface StepEntry {
	/** 步骤状态 emoji */
	icon: "⏳" | "✅" | "❌" | "🔧" | "💭" | "📝";
	/** 步骤标题 */
	title: string;
	/** 步骤详情（可选，折叠显示） */
	detail?: string;
	/** 是否展开详情 */
	expanded?: boolean;
}

/**
 * 构建步骤流卡片 — 模仿 CLI 的逐步显示效果
 *
 * 卡片结构：
 * - Header: 标题 + 状态
 * - Body: 步骤列表（每步一行 markdown，带状态 emoji）
 * - 可选：当前思考/输出区域
 * - 可选：折叠的详细日志
 */
export function buildStepCard(opts: {
	title: string;
	template?: CardHeaderTemplate;
	steps: StepEntry[];
	currentActivity?: string;
	summary?: string;
}): FeishuCardContent {
	const elements: CardBodyElement[] = [];

	// 步骤列表
	if (opts.steps.length > 0) {
		const stepsMarkdown = opts.steps
			.map((s) => `${s.icon} ${s.title}`)
			.join("\n");
		elements.push(mkMarkdown(stepsMarkdown));
	}

	// 有详情的步骤 → 折叠面板
	const detailSteps = opts.steps.filter((s) => s.detail);
	if (detailSteps.length > 0) {
		elements.push({ tag: "hr" });
		for (const s of detailSteps) {
			elements.push(
				mkCollapsiblePanel(
					`${s.icon} ${s.title}`,
					s.detail ?? "",
					s.expanded ?? false,
				),
			);
		}
	}

	// 当前活动（流式思考/输出）
	if (opts.currentActivity) {
		elements.push({ tag: "hr" });
		elements.push(mkMarkdown(`💭 ${opts.currentActivity}`));
	}

	// 总结
	if (opts.summary) {
		elements.push({ tag: "hr" });
		elements.push(mkMarkdown(opts.summary));
	}

	return mkCard(
		opts.title,
		opts.template ?? "blue",
		elements.length > 0 ? elements : [mkMarkdown("初始化中...")],
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
