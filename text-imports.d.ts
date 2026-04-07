/**
 * 声明 .md 文件的 text import 类型（全局）
 *
 * 配合 `import text from "./file.md" with { type: "text" }` 使用，
 * Bun 在编译时将文件内容内联为字符串常量。
 */
declare module "*.md" {
	const content: string;
	export default content;
}
