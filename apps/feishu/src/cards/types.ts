/**
 * 飞书卡片类型定义
 *
 * 定义飞书消息卡片 (Interactive Card v2.0) 的结构类型，
 * 供 card builder 和 bot 层使用。
 */

// ── 卡片颜色主题 ──

export type CardHeaderTemplate =
	| "blue"
	| "wathet"
	| "turquoise"
	| "green"
	| "yellow"
	| "orange"
	| "red"
	| "carmine"
	| "violet"
	| "purple"
	| "indigo"
	| "grey";

// ── 卡片元素 ──

export interface MarkdownElement {
	tag: "markdown";
	content: string;
}

export interface HrElement {
	tag: "hr";
}

export interface CollapsiblePanelElement {
	tag: "collapsible_panel";
	expanded?: boolean;
	header: {
		title: { tag: "plain_text" | "markdown"; content: string };
		icon?: {
			tag: "standard_icon";
			token: string;
			color?: string;
			size?: string;
		};
		icon_position?: "left" | "right" | "follow_text";
		icon_expanded_angle?: -180 | -90 | 90 | 180;
	};
	padding?: string;
	vertical_spacing?: string;
	elements: MarkdownElement[];
}

export type CardBodyElement =
	| MarkdownElement
	| HrElement
	| CollapsiblePanelElement;

// ── 卡片顶层结构 ──

export interface FeishuCardContent {
	schema: "2.0";
	config: { wide_screen_mode: boolean; enable_forward: boolean };
	header: {
		template: CardHeaderTemplate;
		title: { tag: "plain_text"; content: string };
	};
	body: { elements: CardBodyElement[] };
}
