/**
 * 飞书卡片构建器 — 严格 Card JSON 2.0
 *
 * 信息层级设计（参考 CLI RichRenderer）：
 * - 轮次标题：div 组件，灰色小字，建立时间线
 * - thinking：折叠面板内，灰色，次要信息
 * - 工具调用：markdown，▸/◂ 符号，结构化参数
 * - 回复内容：markdown，正常字号，主要信息
 * - 总结：markdown，加粗，最终结果
 */

import type {
	ButtonElement,
	CardBodyElement,
	CardTemplate,
	CollapsiblePanelElement,
	DivElement,
	FeishuCardContent,
	MarkdownElement,
} from "./types.ts";

// ── 基础构建 ──

function txt(s: string): MarkdownElement {
	return { tag: "markdown", content: s.trim() || "(empty)" };
}

/** 灰色小字（用于元信息：round 标题、idle 等） */
function meta(s: string): DivElement {
	return {
		tag: "div",
		text: {
			tag: "plain_text",
			content: s,
			text_size: "notation",
			text_color: "grey",
		},
	};
}

function card(
	title: string,
	tpl: CardTemplate,
	elements: CardBodyElement[],
): FeishuCardContent {
	return {
		schema: "2.0",
		config: { update_multi: true },
		header: {
			template: tpl,
			title: { tag: "plain_text", content: title },
		},
		body: { elements },
	};
}

// ── 简单文本卡片 ──

export function buildTextCard(
	title: string,
	text: string,
	tpl: CardTemplate = "blue",
): FeishuCardContent {
	return card(title, tpl, [txt(text)]);
}

// ── 过程卡片（Agent 轮次） ──

/**
 * 轮次内日志行。
 * kind 控制渲染样式：
 * - "meta": 灰色小字（round 标题、idle）
 * - "thinking": 折叠面板，灰色内容
 * - "tool": ▸/◂ 工具调用摘要
 * - "content": 正文回复
 * - "ok" / "err": 结果行
 */
export type LogKind = "meta" | "thinking" | "tool" | "content" | "ok" | "err";

export interface LogLine {
	kind: LogKind;
	text: string;
	/** 可折叠的详情（仅 thinking/tool 使用） */
	detail?: string;
}

/** 一个完整轮次 */
export interface RoundBlock {
	title: string;
	lines: LogLine[];
	active?: boolean;
}

/**
 * 将 LogLine 渲染为卡片元素
 *
 * 信息层级（对齐 CLI RichRenderer）：
 * - thinking: 灰色文本，次要信息
 * - content: 正常 markdown，主要信息（模型回复）
 * - tool (▸ + detail): 折叠面板，标题=工具名，展开=参数详情
 * - tool (◂): 灰色结果摘要行
 * - ok/err: 状态标签
 * - meta: 灰色小字
 */
function renderLine(line: LogLine): CardBodyElement {
	switch (line.kind) {
		case "meta":
			return meta(line.text);
		case "thinking":
			return txt(`<font color='grey'>${line.detail ?? line.text}</font>`);
		case "tool":
			// ▸ 有 detail → 折叠面板展示参数详情
			if (line.text.startsWith("▸") && line.detail) {
				return {
					tag: "collapsible_panel",
					expanded: false,
					header: {
						title: { tag: "markdown", content: line.text },
						vertical_align: "center",
						padding: "2px 4px 2px 4px",
						icon: {
							tag: "standard_icon",
							token: "down-small-ccm_outlined",
							size: "12px 12px",
						},
						icon_position: "right",
						icon_expanded_angle: -180,
					},
					vertical_spacing: "2px",
					padding: "4px 8px 4px 8px",
					elements: [txt(`<font color='grey'>${line.detail}</font>`)],
				};
			}
			// ◂ 结果摘要 → 灰色
			if (line.text.startsWith("◂")) {
				return txt(`<font color='grey'>${line.text}</font>`);
			}
			// ▸ 无 detail → 普通行
			return txt(line.text);
		case "content":
			return txt(line.text);
		case "ok":
			return txt(`<text_tag color='green'>完成</text_tag> ${line.text}`);
		case "err":
			return txt(`<text_tag color='red'>错误</text_tag> ${line.text}`);
		default: {
			const _exhaustive: never = line.kind;
			return txt(`Unknown: ${_exhaustive}`);
		}
	}
}

/**
 * 将 RoundBlock 渲染为带样式的折叠面板
 *
 * 样式：灰色背景 + 圆角边框 + markdown 标题（含 text_tag 消息数）
 */
function renderRound(
	block: RoundBlock,
	expanded: boolean,
	/** 追加到面板末尾的额外元素（如流式活动文本） */
	trailingElements?: CardBodyElement[],
): CollapsiblePanelElement {
	const elements: CardBodyElement[] =
		block.lines.length > 0 ? block.lines.map(renderLine) : [];
	if (trailingElements) elements.push(...trailingElements);
	if (elements.length === 0) elements.push(txt("..."));

	// 从 title 中提取消息数（如 "Round 1  ·  6 msgs" → title="Round 1", badge="6 msgs"）
	const sep = block.title.indexOf("·");
	const titleText = sep >= 0 ? block.title.slice(0, sep).trim() : block.title;
	const badge = sep >= 0 ? block.title.slice(sep + 1).trim() : "";
	// plain_text 标题 + text_tag 不兼容，分开处理
	const headerContent = badge
		? `${titleText}    <text_tag color='neutral'>${badge}</text_tag>`
		: titleText;

	return {
		tag: "collapsible_panel",
		expanded,
		background_color: "grey",
		header: {
			title: { tag: "markdown", content: headerContent },
			vertical_align: "center",
			padding: "4px 8px 4px 8px",
			icon: {
				tag: "standard_icon",
				token: "down-small-ccm_outlined",
				size: "16px 16px",
			},
			icon_position: "right",
			icon_expanded_angle: -180,
		},
		border: { color: "grey", corner_radius: "5px" },
		vertical_spacing: "4px",
		padding: "4px 8px 4px 8px",
		elements,
	};
}

/** 构建过程卡片 — 按轮次分块，信息分层 */
export function buildProcessCard(opts: {
	title: string;
	template?: CardTemplate;
	rounds: RoundBlock[];
	activity?: string;
	summary?: string;
	/** 为活动文本元素指定 element_id（CardKit 流式更新用） */
	streamElementId?: string;
}): FeishuCardContent {
	const elements: CardBodyElement[] = [];

	// 构建流式活动元素（放入当前活跃轮次面板内部）
	let streamEl: MarkdownElement | undefined;
	if (opts.activity || opts.streamElementId) {
		streamEl = txt(opts.activity || "...");
		if (opts.streamElementId) streamEl.element_id = opts.streamElementId;
	}

	for (const [i, block] of opts.rounds.entries()) {
		const isLast = i === opts.rounds.length - 1;
		const expanded = isLast && (block.active ?? true);
		// 将流式元素追加到最后一个活跃轮次的面板内部
		const trailing = isLast && expanded && streamEl ? [streamEl] : undefined;
		elements.push(renderRound(block, expanded, trailing));
	}

	// 如果没有轮次但有流式元素，放在卡片顶层
	if (opts.rounds.length === 0 && streamEl) {
		elements.push(streamEl);
	}

	if (opts.summary) {
		elements.push({ tag: "hr" });
		elements.push(txt(opts.summary));
	}

	if (elements.length === 0) {
		elements.push(meta("初始化..."));
	}

	return card(opts.title, opts.template ?? "grey", elements);
}

// ── 列表卡片 ──

function btn(
	label: string,
	value: Record<string, unknown>,
	type: ButtonElement["type"] = "default",
	confirm?: { title: string; text: string },
): ButtonElement {
	return {
		tag: "button",
		text: { tag: "plain_text", content: label },
		type,
		size: "small",
		value,
		confirm: confirm
			? {
					title: { tag: "plain_text", content: confirm.title },
					text: { tag: "plain_text", content: confirm.text },
				}
			: undefined,
	};
}

/** 工作流列表项 */
export interface WorkflowItem {
	name: string;
	description: string;
	path: string;
}

/**
 * 构建工作流列表卡片
 *
 * 信息层级：description > name(灰色)
 * 布局：全宽单列，hr 分隔，按钮 auto 宽度
 */
export function buildWorkflowListCard(
	workflows: WorkflowItem[],
): FeishuCardContent {
	if (workflows.length === 0) {
		return card("工作流", "grey", [txt("暂无工作流。")]);
	}

	const elements: CardBodyElement[] = [];
	for (const [i, wf] of workflows.entries()) {
		if (i > 0) elements.push({ tag: "hr" });

		const desc = wf.description || "(no description)";
		elements.push(txt(`**${desc}**\n<font color='grey'>${wf.name}</font>`));
		elements.push({
			tag: "column_set",
			flex_mode: "none",
			horizontal_spacing: "8px",
			columns: [
				{
					tag: "column",
					width: "auto",
					elements: [
						btn("运行", { action: "workflow_run", name: wf.name }, "primary", {
							title: "确认运行",
							text: `运行工作流「${desc}」？`,
						}),
					],
				},
			],
		});
	}

	return card("工作流", "blue", elements);
}

/** 定时任务列表项 */
export interface CronItem {
	name: string;
	cron: string;
	prompt: string;
	enabled: boolean;
}

/**
 * 构建定时任务列表卡片
 *
 * 信息层级：运行状态 > prompt > cron(自然语言) + name
 * 布局：全宽单列，每项之间用分割线分隔，按钮小尺寸横排
 */
export function buildCronListCard(crons: CronItem[]): FeishuCardContent {
	if (crons.length === 0) {
		return card("定时任务", "grey", [txt("暂无定时任务。")]);
	}

	const elements: CardBodyElement[] = [];
	for (const [i, c] of crons.entries()) {
		if (i > 0) elements.push({ tag: "hr" });

		const statusBadge = c.enabled
			? "<text_tag color='turquoise'>运行中</text_tag>"
			: "<text_tag color='neutral'>已暂停</text_tag>";
		const desc = c.prompt ? compact(c.prompt, 120) : "(无描述)";
		const schedule = cronToNatural(c.cron);

		elements.push(
			txt(
				`${statusBadge}  **${desc}**\n<font color='grey'>${c.name} · ${schedule}</font>`,
			),
		);

		const toggleLabel = c.enabled ? "暂停" : "启用";
		const toggleType: ButtonElement["type"] = c.enabled ? "default" : "primary";

		elements.push({
			tag: "column_set",
			flex_mode: "none",
			horizontal_spacing: "8px",
			columns: [
				{
					tag: "column",
					width: "auto",
					elements: [
						btn(
							toggleLabel,
							{ action: "cron_toggle", name: c.name, enabled: !c.enabled },
							toggleType,
						),
					],
				},
				{
					tag: "column",
					width: "auto",
					elements: [
						btn("立即运行", { action: "cron_run", name: c.name }, "primary", {
							title: "确认运行",
							text: `立即运行「${desc}」？`,
						}),
					],
				},
			],
		});
	}

	return card("定时任务", "blue", elements);
}

// ── 工具函数 ──

function compact(text: string, limit: number): string {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return "(empty)";
	return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/** 将 cron 表达式转为自然语言 */
function cronToNatural(expr: string): string {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return expr;
	const min = parts[0] ?? "*";
	const hour = parts[1] ?? "*";
	const day = parts[2] ?? "*";
	const month = parts[3] ?? "*";
	const weekday = parts[4] ?? "*";

	const pad = (s: string) => s.padStart(2, "0");
	const weekNames: Record<string, string> = {
		"0": "周日",
		"1": "周一",
		"2": "周二",
		"3": "周三",
		"4": "周四",
		"5": "周五",
		"6": "周六",
		"7": "周日",
	};

	const time = hour !== "*" && min !== "*" ? `${pad(hour)}:${pad(min)}` : null;

	if (hour === "*" && min.startsWith("*/")) return `每 ${min.slice(2)} 分钟`;
	if (hour === "*" && min === "0") return "每小时";
	if (hour === "*" && min !== "*") return `每小时 :${pad(min)}`;
	if (day === "*" && month === "*" && weekday !== "*" && time) {
		return `每${weekNames[weekday] ?? `周${weekday}`} ${time}`;
	}
	if (day === "*" && month === "*" && weekday === "*" && time) {
		return `每天 ${time}`;
	}
	if (day !== "*" && month === "*" && weekday === "*" && time) {
		return `每月 ${day} 日 ${time}`;
	}
	return expr;
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
