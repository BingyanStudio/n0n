/**
 * @n0n/shared — 跨包共享的纯工具函数
 *
 * 仅依赖 @n0n/types，不依赖任何配置或运行时状态。
 * 所有函数都是纯函数，通过参数接收所需上下文。
 */

export {
	adaptTagsFor,
	closeTag,
	detectTagStyle,
	openTag,
	type TagStyle,
	wrapTagFor,
} from "./tags.ts";
