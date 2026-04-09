/**
 * Token 预估工具函数
 *
 * 动机：LLM 消耗 token 而非字符。字符数与 token 数偏差显著（英文 5:1、中文 1:1、JSON ~2.5:1），
 * 用字符数做截断阈值对不同内容类型的实际 token 开销差异可达 3-5 倍。
 *
 * 工具：tokenx（96% 精准度，2kB，无依赖，纯计算无 WASM）。
 *
 * 接入点分类：
 * - 逻辑判断（executor.ts 截断、rag.ts 内容截取）→ 使用 estimateTokens 做决策
 * - 人类展示（rich-renderer.ts）→ 字符数后追加 dim `~N tok`
 * - 模型展示（format-prompt.ts）→ 保持字符数，模型不需知道 token 开销
 * - 真实数据（API usage）→ 不需要预估
 *
 * ExecTruncated.stdoutLength 等字段保持字符数（客观事实数据），
 * token 预估是派生数据，由展示层动态计算。
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
