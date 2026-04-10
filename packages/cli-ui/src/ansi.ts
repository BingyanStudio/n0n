/**
 * ANSI 工具层 — 颜色标签 + 光标控制
 *
 * 颜色基于 picocolors（自动处理 NO_COLOR / 管道检测）。
 * 光标控制为 raw ANSI escape sequences。
 */

import pc from "picocolors";
import stringWidth from "string-width";

const out = process.stderr;

// ── 角色标签 ──

export const label = {
	user: () => pc.bgGreen(pc.black(" USER ")),
	agent: () => pc.bgYellow(pc.black(" AGENT ")),
	tool: () => pc.bgBlue(pc.black(" TOOL ")),
	system: () => pc.bgMagenta(pc.black(" SYS ")),
} as const;

// ── 文本样式 ──

export const style = {
	dim: pc.dim,
	gray: pc.gray,
	green: pc.green,
	red: pc.red,
	yellow: pc.yellow,
	cyan: pc.cyan,
	bold: pc.bold,
	white: pc.white,
	bgGreen: pc.bgGreen,
} as const;

// ── 光标控制（写入 stderr） ──

// TODO: 同步输出协议（Synchronized Output）
// 现代终端（iTerm2, Kitty, Windows Terminal, foot 等）支持 DCS 序列：
//   开始批量更新: "\x1b[?2026h"  (也称 Mode 2026, 或 "\x1bP=1s\x1b\\" DCS 形式)
//   结束批量更新: "\x1b[?2026l"
// 在 begin/end 之间，终端暂停屏幕渲染，收到 end 后一次性刷新。
// 可以包裹 LiveRegion 的 clear+rewrite 周期，从协议层面彻底消除撕裂和闪烁。
// 需要做终端能力检测（DECRPM 查询或 $TERM_PROGRAM 白名单），不支持的终端直接忽略即可。

/** 光标上移 n 行 */
export function cursorUp(n: number): void {
	if (n > 0) out.write(`\x1b[${n}A`);
}

/** 清除当前行 + 光标移到行首 */
export function clearLine(): void {
	out.write("\x1b[2K\x1b[0G");
}

/** 清除从光标到行尾 */
export function clearToEnd(): void {
	out.write("\x1b[0K");
}

/** 清除从光标到屏幕末尾（含当前行） */
export function clearDown(): void {
	out.write("\x1b[J");
}

/** 隐藏光标 */
export function hideCursor(): void {
	out.write("\x1b[?25l");
}

/** 显示光标 */
export function showCursor(): void {
	out.write("\x1b[?25h");
}

/** 写入 stderr（不换行） */
export function write(text: string): void {
	out.write(text);
}

/** 写入 stderr（换行） */
export function writeln(text = ""): void {
	out.write(`${text}\n`);
}

/**
 * 检测是否为 TTY（支持 ANSI 光标控制）
 *
 * Bun 1.x 在 Windows 上未实现 process.stderr.isTTY（始终 undefined），
 * 但终端实际支持 ANSI。使用 picocolors 的颜色支持检测作为可靠代理：
 * 如果颜色可用，说明 stderr 连接到支持 ANSI 的终端，光标控制也可用。
 */
export const isTTY: boolean = out.isTTY ?? pc.isColorSupported;

/** 去除 ANSI 转义序列 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires control chars
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** 计算字符串的可见终端列宽（自动去除 ANSI，正确处理 CJK/全角/emoji） */
export function visibleWidth(s: string): number {
	return stringWidth(s);
}

/** 获取终端列宽 */
export function terminalColumns(): number {
	return out.columns || 80;
}
