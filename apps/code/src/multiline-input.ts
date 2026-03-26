/**
 * 多行输入收集器
 *
 * 支持两种多行输入场景：
 * 1. **粘贴检测**：行间隔极短（< PASTE_THRESHOLD_MS）时自动累积，粘贴结束后自动提交
 * 2. **手动多行**：首行非空时进入收集模式，输入空行（连按两次回车）提交
 *
 * 单行快速输入体验不变：输入一行后短暂等待，无后续行则立即提交。
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
		let timer: ReturnType<typeof setTimeout> | null = null;

		function submit() {
			cleanup();
			resolve(lines.join("\n"));
		}

		function cleanup() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			rl.removeListener("line", onLine);
		}

		function onLine(line: string) {
			const now = Date.now();
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}

			const isPaste =
				lastLineTime > 0 && now - lastLineTime < PASTE_THRESHOLD_MS;
			lastLineTime = now;

			// 空行逻辑：
			// - 如果是粘贴中的空行，正常累积
			// - 如果是手动输入的空行且已有内容，提交
			// - 如果首行就是空行，提交空内容（由调用方处理）
			if (line === "" && !isPaste) {
				if (lines.length === 0) {
					submit();
					return;
				}
				submit();
				return;
			}

			lines.push(line);

			// 设置短延时：如果没有后续行到达，自动提交
			// 粘贴场景：后续行会在阈值内到达并重置 timer
			// 单行场景：等待 PASTE_THRESHOLD_MS 后自动提交
			timer = setTimeout(() => {
				submit();
			}, PASTE_THRESHOLD_MS);

			// 切换为续行提示符，等待下一行输入
			rl.setPrompt(CONTINUATION_PROMPT);
			rl.prompt();
		}

		// 显示首行 prompt 并开始监听
		rl.setPrompt(promptLabel);
		rl.prompt();
		rl.on("line", onLine);
	});
}
