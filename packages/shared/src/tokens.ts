/**
 * Token 预估工具函数
 *
 * 使用 tokenx（96% 精准度，2kB，无依赖）做 token 数预估。
 * 用于截断判断和展示层 token 数追加显示。
 */

import { estimateTokenCount } from "tokenx";

/** 预估字符串的 token 数 */
export function estimateTokens(text: string): number {
	return estimateTokenCount(text);
}

/** 从字符串末尾截取约 maxTokens 个 token 的内容（二分法定位） */
export function tailByTokens(text: string, maxTokens: number): string {
	if (estimateTokens(text) <= maxTokens) return text;
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (estimateTokens(text.slice(mid)) > maxTokens) lo = mid + 1;
		else hi = mid;
	}
	return text.slice(lo);
}

/** 从字符串开头截取约 maxTokens 个 token 的内容（二分法定位） */
export function headByTokens(text: string, maxTokens: number): string {
	if (estimateTokens(text) <= maxTokens) return text;
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (estimateTokens(text.slice(0, mid)) > maxTokens) hi = mid - 1;
		else lo = mid;
	}
	return text.slice(0, lo);
}
