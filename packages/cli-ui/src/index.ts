/**
 * @n0n/cli-ui — 共享终端 UI 组件
 *
 * 提供 ANSI 颜色/光标控制、LiveRegion 行替换、RichRenderer 富终端渲染。
 * 供 apps/cli 和 apps/code 等终端应用共享。
 */

export {
	clearLine,
	cursorUp,
	getTerminalWidth,
	isTTY,
	label,
	style,
	write,
	writeln,
} from "./ansi.ts";
export { computeDisplayLines, LiveRegion } from "./live-region.ts";
export { RichRenderer } from "./rich-renderer.ts";
export { CliSetupRenderer } from "./setup-renderer.ts";
export { stripAnsi } from "./strip-ansi.ts";
