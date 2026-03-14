/**
 * stripAnsi — 移除 ANSI 转义序列，返回纯可见文本
 *
 * 用于计算字符串在终端中的实际显示宽度。
 * ANSI 转义序列（颜色、光标控制等）不占显示宽度，需要剥离后再计算。
 */

// 匹配所有 ANSI 转义序列：CSI 序列 + OSC 序列 + 简单转义
const ANSI_RE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape detection requires matching control characters
	/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

export function stripAnsi(str: string): string {
	return str.replace(ANSI_RE, "");
}
