/**
 * 飞书卡片类型定义 — 严格遵循 Card JSON 2.0 结构
 *
 * 参考文档：docs/feishu/卡片 JSON 2.0 结构.md
 * 注意：v2.0 对不支持的属性会报错，类型必须精确。
 */

// ── 卡片颜色主题 ──

export type CardTemplate =
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

// ── 文本元素 ──

export interface PlainTextElement {
	tag: "plain_text";
	content: string;
}

// ── 展示类组件 ──

export interface MarkdownElement {
	tag: "markdown";
	content: string;
	text_align?: "left" | "center" | "right";
	text_size?: string;
	/** CardKit 组件唯一标识，用于流式更新等组件级操作 */
	element_id?: string;
}

export interface DivElement {
	tag: "div";
	text: PlainTextElement & {
		text_size?: string;
		text_color?: string;
		text_align?: string;
	};
	icon?: { tag: "standard_icon"; token: string; color?: string };
}

export interface HrElement {
	tag: "hr";
}

// ── 容器类组件 ──

export interface CollapsiblePanelElement {
	tag: "collapsible_panel";
	expanded?: boolean;
	background_color?: string;
	header: {
		title: PlainTextElement | MarkdownElement;
		background_color?: string;
		vertical_align?: "top" | "center" | "bottom";
		padding?: string;
		icon?: {
			tag: "standard_icon";
			token: string;
			color?: string;
			size?: string;
		};
		icon_position?: "left" | "right" | "follow_text";
		icon_expanded_angle?: -180 | -90 | 90 | 180;
	};
	border?: { color?: string; corner_radius?: string };
	padding?: string;
	vertical_spacing?: string;
	elements: CardBodyElement[];
}

export interface ColumnElement {
	tag: "column";
	width: "weighted" | "auto";
	weight?: number;
	vertical_align?: "top" | "center" | "bottom";
	elements: CardBodyElement[];
}

export interface ColumnSetElement {
	tag: "column_set";
	flex_mode?: "none" | "stretch" | "flow" | "bisect";
	horizontal_spacing?: string;
	columns: ColumnElement[];
	margin?: string;
}

// ── 交互类组件 ──

export interface ButtonElement {
	tag: "button";
	text: PlainTextElement;
	type?: "default" | "primary" | "danger" | "text";
	size?: "medium" | "small" | "tiny";
	width?: "default" | "fill";
	value?: Record<string, unknown>;
	confirm?: {
		title: PlainTextElement;
		text: PlainTextElement;
	};
}

// ── 联合类型 ──

export type CardBodyElement =
	| MarkdownElement
	| DivElement
	| HrElement
	| CollapsiblePanelElement
	| ColumnSetElement
	| ButtonElement;

// ── 卡片顶层结构（v2.0） ──

export interface FeishuCardContent {
	schema: "2.0";
	config: {
		update_multi: true;
		enable_forward?: boolean;
		streaming_mode?: boolean;
		summary?: { content: string };
		streaming_config?: {
			print_frequency_ms?: { default: number };
			print_step?: { default: number };
			print_strategy?: "fast" | "delay";
		};
	};
	header: {
		template: CardTemplate;
		title: PlainTextElement;
	};
	body: {
		elements: CardBodyElement[];
	};
}
