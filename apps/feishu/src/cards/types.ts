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

// ── 交互元素 ──

export interface ButtonElement {
	tag: "button";
	text: { tag: "plain_text"; content: string };
	type?: "default" | "primary" | "danger" | "text";
	size?: "medium" | "small" | "tiny";
	width?: "default" | "fill" | string;
	value?: Record<string, unknown>;
	confirm?: {
		title: { tag: "plain_text"; content: string };
		text: { tag: "plain_text"; content: string };
	};
}

export interface ActionElement {
	tag: "action";
	actions: ButtonElement[];
	layout?: "bisected" | "trisection" | "flow";
}

export interface ColumnElement {
	tag: "column";
	width: "weighted" | "auto" | string;
	weight?: number;
	vertical_align?: "top" | "center" | "bottom";
	elements: (MarkdownElement | ButtonElement | ActionElement)[];
}

export interface ColumnSetElement {
	tag: "column_set";
	flex_mode?: "none" | "stretch" | "flow" | "bisect";
	background_style?: "default" | "grey";
	horizontal_spacing?: "default" | "small";
	columns: ColumnElement[];
}

export type CardBodyElement =
	| MarkdownElement
	| HrElement
	| CollapsiblePanelElement
	| ActionElement
	| ColumnSetElement;

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
