#!/usr/bin/env bun
/**
 * tarot — 有状态的塔罗占卜 CLI
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { draw, DECK, type Card } from "./deck.ts";

// ── 牌阵定义 ──

interface Spread {
	name: string;
	description: string;
	positions: string[];
}

const SPREADS: Record<string, Spread> = {
	single: {
		name: "单牌",
		description: "一张牌的启示",
		positions: ["启示"],
	},
	three: {
		name: "时间之流",
		description: "过去、现在与未来",
		positions: ["过去", "现在", "未来"],
	},
	situation: {
		name: "处境之镜",
		description: "你的处境、面临的挑战、可能的行动",
		positions: ["处境", "挑战", "建议"],
	},
	cross: {
		name: "简易十字",
		description: "五方位展开，兼顾过去与未来",
		positions: ["现状", "挑战", "过去", "未来", "潜力"],
	},
	horseshoe: {
		name: "马蹄牌阵",
		description: "七张牌的完整路径",
		positions: ["过去", "现在", "隐藏因素", "障碍", "周围环境", "建议", "结果"],
	},
	celtic: {
		name: "凯尔特十字",
		description: "十张牌的全面诊断",
		positions: [
			"核心",
			"交叉",
			"表层意识",
			"深层根源",
			"过去",
			"未来",
			"自身",
			"环境",
			"希望与恐惧",
			"结果",
		],
	},
};

const DEFAULT_SPREAD = "three";

// ── 状态 ──

type Phase = "idle" | "focused" | "drawn" | "complete";

interface SpreadSlot {
	cardIndex: number;
	reversed: boolean;
	position: string;
	revealed: boolean;
}

interface Session {
	phase: Phase;
	question?: string;
	spreadType?: string;
	spread: SpreadSlot[];
}

const STATE_PATH = resolve(process.cwd(), ".tarot-session.json");

function loadSession(): Session {
	if (existsSync(STATE_PATH)) {
		return JSON.parse(readFileSync(STATE_PATH, "utf8"));
	}
	return { phase: "idle", spread: [] };
}

function saveSession(session: Session): void {
	writeFileSync(STATE_PATH, JSON.stringify(session, null, "\t"), "utf8");
}

// ── 渲染 ──

function displayWidth(str: string): number {
	let w = 0;
	for (const ch of str) {
		const code = ch.codePointAt(0)!;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0x303e) ||
			(code >= 0x3040 && code <= 0x33bf) ||
			(code >= 0x3400 && code <= 0x4dbf) ||
			(code >= 0x4e00 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7af) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff01 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x20000 && code <= 0x2fa1f);
		w += wide ? 2 : 1;
	}
	return w;
}

function padEnd(str: string, width: number): string {
	const diff = width - displayWidth(str);
	return diff > 0 ? str + " ".repeat(diff) : str;
}

function renderCard(card: Card, reversed: boolean): string {
	const orientation = reversed ? "逆位 ↓" : "正位 ↑";
	const meaning = reversed ? card.reversed : card.upright;
	const suitLabel = card.suit ? ` · ${card.suit}` : "";
	const W = 30;
	const line1 = `  │  ${card.numeral}. ${card.name}${suitLabel}`;
	const line2 = `  │  ${card.nameEn}`;
	const line3 = `  │       ${orientation}`;
	return [
		"  ┌" + "─".repeat(W) + "┐",
		padEnd(line1, W + 3) + "│",
		padEnd(line2, W + 3) + "│",
		"  │" + " ".repeat(W) + "│",
		padEnd(line3, W + 3) + "│",
		"  └" + "─".repeat(W) + "┘",
		"",
		`  牌意：${meaning}`,
	].join("\n");
}

// ── 参数解析 ──

function hasFlag(args: string[], ...flags: string[]): boolean {
	return args.some((a) => flags.includes(a));
}

function consumeFlag(args: string[], ...flags: string[]): string[] {
	return args.filter((a) => !flags.includes(a));
}

// ── 命令 ──

function cmdFocus(args: string[]): void {
	if (hasFlag(args, "--help", "-h")) {
		console.log(`tarot focus — 冥想你的问题

Usage: tarot focus <question>

在开始抽牌之前，先静心想好你要问的问题。
问题会被记录，并在占卜完成时重新展示。`);
		return;
	}

	const question = consumeFlag(args, "--help", "-h").join(" ") || "（未指定问题）";
	const session = loadSession();
	if (session.phase !== "idle") {
		console.log("⚠ 当前已有进行中的占卜。如需重新开始，请先执行 tarot reset。");
		return;
	}

	console.log("🔮 塔罗占卜\n");
	console.log("请静心冥想你的问题……\n");
	console.log(`  「${question}」\n`);
	console.log("✦ 已记录。当你准备好时，请抽取牌。");

	session.phase = "focused";
	session.question = question;
	saveSession(session);
}

function cmdDraw(args: string[]): void {
	if (hasFlag(args, "--help", "-h")) {
		console.log(`tarot draw — 洗牌并抽取

Usage: tarot draw [牌阵名称 | 数字]

不带参数默认使用「时间之流」三牌阵。
传入数字可抽取任意张数（自动编号位置）。

可用牌阵：
`);
		for (const [key, s] of Object.entries(SPREADS)) {
			console.log(`  ${padEnd(key, 14)}${s.name}（${s.positions.length} 张）— ${s.description}`);
		}
		console.log(`
示例：
  tarot draw              使用默认三牌阵
  tarot draw single       单牌占卜
  tarot draw celtic       凯尔特十字
  tarot draw 5            自定义抽 5 张`);
		return;
	}

	const session = loadSession();
	if (session.phase === "idle") {
		console.log("⚠ 请先冥想你的问题。执行 tarot focus <question>");
		return;
	}
	if (session.phase === "drawn" || session.phase === "complete") {
		console.log("⚠ 牌已经抽过了。如需重新开始，请先执行 tarot reset。");
		return;
	}

	const cleaned = consumeFlag(args, "--help", "-h");
	const arg = cleaned[0];

	let positions: string[];
	let spreadLabel: string;

	if (!arg) {
		const s = SPREADS[DEFAULT_SPREAD]!;
		positions = s.positions;
		spreadLabel = s.name;
	} else if (arg in SPREADS) {
		const s = SPREADS[arg]!;
		positions = s.positions;
		spreadLabel = s.name;
	} else {
		const n = Number.parseInt(arg, 10);
		if (Number.isNaN(n) || n < 1 || n > 78) {
			console.log(`⚠ 未知的牌阵「${arg}」。执行 tarot draw --help 查看可用牌阵。`);
			return;
		}
		positions = Array.from({ length: n }, (_, i) => `第${i + 1}张`);
		spreadLabel = `${n} 张自定义`;
	}

	const drawnCards = draw(positions.length);

	session.phase = "drawn";
	session.spreadType = spreadLabel;
	session.spread = drawnCards.map((dc, i) => ({
		cardIndex: DECK.indexOf(dc.card),
		reversed: dc.reversed,
		position: positions[i]!,
		revealed: false,
	}));

	console.log("🎴 正在洗牌……\n");
	console.log(`✦ 牌已洗好。牌阵「${spreadLabel}」— 你抽取了 ${positions.length} 张牌，面朝下排列在你面前。\n`);

	for (const slot of session.spread) {
		console.log(`  [✦]  ${slot.position}`);
	}

	console.log("\n准备好后，逐一翻开它们。");
	saveSession(session);
}

function cmdReveal(args: string[]): void {
	if (hasFlag(args, "--help", "-h")) {
		console.log(`tarot reveal — 翻开下一张牌

Usage: tarot reveal

每次翻开一张。最后一张翻完后展示完整牌面总览。`);
		return;
	}

	const session = loadSession();
	if (session.phase !== "drawn") {
		if (session.phase === "idle" || session.phase === "focused") {
			console.log("⚠ 还没有抽牌。请先执行 tarot draw。");
		} else {
			console.log("⚠ 所有牌已翻开。本次占卜已完成。");
		}
		return;
	}

	const nextIdx = session.spread.findIndex((s) => !s.revealed);
	if (nextIdx === -1) {
		session.phase = "complete";
		saveSession(session);
		console.log("⚠ 所有牌已翻开。本次占卜已完成。");
		return;
	}

	const slot = session.spread[nextIdx]!;
	slot.revealed = true;

	const card = DECK[slot.cardIndex]!;
	const remaining = session.spread.filter((s) => !s.revealed).length;

	console.log(`✦ 翻开第 ${nextIdx + 1} 张牌 —— 「${slot.position}」\n`);
	console.log(renderCard(card, slot.reversed));

	if (remaining > 0) {
		console.log(`\n还有 ${remaining} 张牌未翻开。`);
		console.log(`\n⚡ 在翻开下一张之前，请先解读这张「${slot.position}」位的牌——它在你的问题上意味着什么？`);
	} else {
		session.phase = "complete";
		console.log("\n✦ 所有牌已翻开。请静心感受这些牌在你问题上的启示。");
		console.log(`\n你的问题：「${session.question}」`);
		if (session.spreadType) {
			console.log(`牌阵：「${session.spreadType}」`);
		}
		console.log("\n── 完整牌面 ──\n");
		for (const s of session.spread) {
			const c = DECK[s.cardIndex]!;
			const orient = s.reversed ? "逆位" : "正位";
			console.log(`  ${s.position}：${c.numeral}. ${c.name}（${orient}）`);
		}
		console.log("\n冥想这些牌的组合，让它们为你的下一步指引方向。");
		console.log("\n⚡ 现在请综合解读所有牌面：它们作为整体，对你的问题揭示了什么？牌与牌之间有怎样的呼应或张力？");
	}

	saveSession(session);
}

function cmdReading(args: string[]): void {
	if (hasFlag(args, "--help", "-h")) {
		console.log(`tarot reading — 查看当前占卜状态

Usage: tarot reading

展示本次占卜的问题、已翻开的牌面和未翻开的牌。`);
		return;
	}

	const session = loadSession();
	if (session.phase === "idle") {
		console.log("当前没有进行中的占卜。");
		return;
	}

	console.log("🔮 当前占卜状态\n");
	if (session.question) {
		console.log(`  问题：「${session.question}」`);
	}
	if (session.spreadType) {
		console.log(`  牌阵：「${session.spreadType}」`);
	}
	console.log();

	if (session.spread.length === 0) {
		console.log("  尚未抽牌。");
		return;
	}

	for (let i = 0; i < session.spread.length; i++) {
		const slot = session.spread[i]!;
		if (slot.revealed) {
			const card = DECK[slot.cardIndex]!;
			const orient = slot.reversed ? "逆位 ↓" : "正位 ↑";
			const meaning = slot.reversed ? card.reversed : card.upright;
			console.log(`  ${i + 1}. 「${slot.position}」 ${card.numeral}. ${card.name}（${orient}）`);
			console.log(`     ${meaning}\n`);
		} else {
			console.log(`  ${i + 1}. 「${slot.position}」 [未翻开]\n`);
		}
	}
}

function cmdReset(args: string[]): void {
	if (hasFlag(args, "--help", "-h")) {
		console.log(`tarot reset — 重置占卜

Usage: tarot reset

清除当前占卜状态，回到初始状态。`);
		return;
	}

	saveSession({ phase: "idle", spread: [] });
	console.log("✦ 占卜已重置。当你准备好时，重新开始。");
}

function showHelp(): void {
	console.log(`🔮 tarot — 塔罗占卜 CLI

Usage: tarot <command> [options]

Commands:
  focus <question>        冥想你的问题
  draw [牌阵|数字]        洗牌并抽取（默认: 时间之流三牌阵）
  reveal                  翻开下一张牌
  reading                 查看当前占卜全貌
  reset                   重置占卜

Options:
  -h, --help              显示帮助信息

可用牌阵（tarot draw --help 查看详情）：
  single      单牌        three       时间之流
  situation   处境之镜    cross       简易十字
  horseshoe   马蹄牌阵    celtic      凯尔特十字

示例：
  tarot focus "我的项目下一步该往哪个方向走？"
  tarot draw celtic
  tarot reveal
  tarot reading`);
}

// ── 入口 ──

const args = process.argv.slice(2);
const command = args[0];

if (!command || hasFlag(args, "--help", "-h") && !command) {
	showHelp();
	process.exit(0);
}

const subArgs = args.slice(1);

switch (command) {
	case "focus":
		cmdFocus(subArgs);
		break;
	case "draw":
		cmdDraw(subArgs);
		break;
	case "reveal":
		cmdReveal(subArgs);
		break;
	case "reading":
		cmdReading(subArgs);
		break;
	case "reset":
		cmdReset(subArgs);
		break;
	case "--help":
	case "-h":
		showHelp();
		break;
	default:
		console.log(`未知命令: ${command}\n`);
		showHelp();
		process.exit(1);
}
