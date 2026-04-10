/**
 * SGR 鼠标模式测试 Demo
 *
 * 运行: bun scripts/test-sgr-mouse.ts
 * 退出: 按 q 或 Ctrl+C
 *
 * 如果你的终端支持 SGR 鼠标，移动鼠标、点击、滚轮都会在屏幕上实时显示事件信息。
 * 如果什么都没显示，说明终端不支持或未正确启用。
 */

const stdin = process.stdin;
const out = process.stderr;

// SGR 鼠标模式转义序列
const ENABLE_MOUSE = [
	"\x1b[?1000h", // 基础鼠标追踪（点击）
	"\x1b[?1002h", // 按钮事件追踪（拖拽）
	"\x1b[?1003h", // 任意事件追踪（移动）
	"\x1b[?1006h", // SGR 扩展模式（支持超过 223 列/行）
].join("");

const DISABLE_MOUSE = [
	"\x1b[?1006l",
	"\x1b[?1003l",
	"\x1b[?1002l",
	"\x1b[?1000l",
].join("");

const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function cleanup() {
	out.write(DISABLE_MOUSE);
	out.write(SHOW_CURSOR);
	out.write("\x1b[?1049l"); // 离开备用屏幕
	stdin.setRawMode(false);
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
	cleanup();
	process.exit(0);
});

// 进入备用屏幕 + 启用鼠标
out.write("\x1b[?1049h"); // 备用屏幕
out.write(CLEAR_SCREEN);
out.write(HIDE_CURSOR);
out.write(ENABLE_MOUSE);

stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding("utf8");

// 解析 SGR 鼠标序列: \x1b[<btn;col;row[Mm]
const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

let eventCount = 0;

function drawHeader() {
	out.write("\x1b[1;1H"); // 移到第1行
	out.write("\x1b[1;36m"); // cyan
	out.write("=== SGR Mouse Mode Test ===");
	out.write("\x1b[0m");
	out.write("\x1b[2;1H");
	out.write("\x1b[90m"); // gray
	out.write("移动鼠标、点击、滚轮试试看。按 q 退出。");
	out.write("\x1b[0m");
	out.write("\x1b[3;1H");
	out.write("\x1b[90m─".repeat(50));
	out.write("\x1b[0m");
}

drawHeader();

function decodeButton(btn: number, released: boolean): string {
	// 滚轮
	if (btn & 64) {
		const dir = (btn & 1) ? "down" : "up";
		return `scroll-${dir}`;
	}
	// 移动（无按钮按下）
	if (btn & 32) {
		const base = btn & 3;
		if (base === 0) return "move+left";
		if (base === 1) return "move+middle";
		if (base === 2) return "move+right";
		return "move";
	}
	// 按钮
	const base = btn & 3;
	const action = released ? "release" : "press";
	if (base === 0) return `left-${action}`;
	if (base === 1) return `middle-${action}`;
	if (base === 2) return `right-${action}`;
	return `button${base}-${action}`;
}

function decodeModifiers(btn: number): string {
	const mods: string[] = [];
	if (btn & 4) mods.push("Shift");
	if (btn & 8) mods.push("Alt");
	if (btn & 16) mods.push("Ctrl");
	return mods.length > 0 ? ` [${mods.join("+")}]` : "";
}

stdin.on("data", (data: string) => {
	// 按 q 退出
	if (data === "q" || data === "\x03") {
		cleanup();
		process.exit(0);
	}

	let match: RegExpExecArray | null;
	SGR_RE.lastIndex = 0;

	while ((match = SGR_RE.exec(data)) !== null) {
		const btn = parseInt(match[1]!, 10);
		const col = parseInt(match[2]!, 10);
		const row = parseInt(match[3]!, 10);
		const released = match[4] === "m";

		eventCount++;
		const event = decodeButton(btn, released);
		const mods = decodeModifiers(btn);

		// 在第5行之后滚动显示最新事件
		const displayRow = 5 + (eventCount % 15);
		out.write(`\x1b[${displayRow};1H`);
		out.write("\x1b[2K"); // 清除该行

		const color = event.startsWith("scroll") ? "\x1b[33m" // yellow
			: event.includes("press") ? "\x1b[32m" // green
			: event.includes("release") ? "\x1b[31m" // red
			: "\x1b[90m"; // gray (move)

		out.write(`${color}#${eventCount}\x1b[0m  `);
		out.write(`${color}${event}\x1b[0m${mods}  `);
		out.write(`\x1b[90mrow=${row} col=${col}  btn_raw=${btn}\x1b[0m`);

		// 更新标题栏的事件计数
		out.write("\x1b[1;40H");
		out.write(`\x1b[33m events: ${eventCount}\x1b[0m  `);
	}
});
