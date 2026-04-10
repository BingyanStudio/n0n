/**
 * 声明音频文件的 file import 类型（全局）
 *
 * 配合 `import path from "./file.wav" with { type: "file" }` 使用，
 * Bun 在运行时返回文件的绝对路径字符串。
 */
declare module "*.wav" {
	const path: string;
	export default path;
}
