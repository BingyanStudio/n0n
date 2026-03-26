/**
 * 多行输入收集器
 *
 * 统一使用「空行提交」的交互模式：
 * - 用户输入内容后，按下空行（再次回车）提交
 * - 粘贴多行内容时，粘贴中的空行不会触发提交（通过行间隔检测区分粘贴与手动输入）
 * - 粘贴结束后用户可继续编辑或追加内容，最后按空行提交
 *
 * 行间隔 < PASTE_THRESHOLD_MS 视为粘贴行为，期间所有内容（含空行）正常累积。
 */

import type { Interface as ReadlineInterface } from "node:readline";
import { isTTY, style } from "@n0n/cli-ui";

/** 粘贴检测阈值（毫秒）— 两行间隔低于此值视为粘贴 */
const PASTE_THRESHOLD_MS = 50;

/** 续行提示符 */
const CONTINUATION_PROMPT = isTTY ? style.gray("... ") : "";

/**
 * 读取用户多行输入
 *
 * @param rl - readline 实例
 * @param promptLabel - 首行提示符（如 " USER "）
 * @param closed - 是否已关闭的引用
 * @returns 用户输入的完整文本（多行用 \n 连接）
 */
export function readMultilineInput(
	rl: ReadlineInterface,
	promptLabel: string,
	closed: { value: boolean },
): Promise<string> {
	return new Promise<string>((resolve) => {
		if (closed.value) return resolve("exit");

		const lines: string[] = [];
		let lastLineTime = 0;

		function submit() {
			rl.removeListener("line", onLine);
			resolve(lines.join("\n"));
		}

		function onLine(line: string) {
			const now = Date.now();
			const isPaste =
				lastLineTime > 0 && now - lastLineTime < PASTE_THRESHOLD_MS;
			lastLineTime = now;

			// 空行处理：
			// - 粘贴中的空行 → 正常累积（粘贴内容可能包含空行）
			// - 手动输入的空行 → 提交已收集的内容
			if (line === "" && !isPaste) {
				submit();
				return;
			}

			lines.push(line);

			// 显示续行提示符，等待下一行
			rl.setPrompt(CONTINUATION_PROMPT);
			rl.prompt();
		}

		// 显示首行 prompt 并开始监听
		rl.setPrompt(promptLabel);
		rl.prompt();
		rl.on("line", onLine);
	});
}
