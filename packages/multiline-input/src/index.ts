/**
 * @n0n/multiline-input — 终端多行输入组件
 *
 * 基于 raw mode + bracketed paste mode 的多行文本输入，
 * 提供可靠的粘贴识别和宽字符（中文/emoji）光标定位。
 */

export { InputBuffer } from "./input-buffer.ts";
export {
	readMultilineInput,
	type MultilineInputOptions,
	type MultilineInputResult,
} from "./reader.ts";
