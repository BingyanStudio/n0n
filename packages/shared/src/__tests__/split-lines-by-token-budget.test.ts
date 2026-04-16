import { describe, expect, it } from "bun:test";
import { estimateTokens, splitLinesByTokenBudget } from "../tokens.ts";

describe("splitLinesByTokenBudget", () => {
	it("小文本不分块（单块）", () => {
		const text = "line 1\nline 2\nline 3";
		const chunks = splitLinesByTokenBudget(text, 1000);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.startLine).toBe(1);
		expect(chunks[0]!.endLine).toBe(3);
	});

	it("空文本返回空数组", () => {
		expect(splitLinesByTokenBudget("", 100)).toHaveLength(0);
	});

	it("大文本按预算分成多块", () => {
		// 构造一个约 200 token 每行的文本（每行约 50 个英文单词）
		const longLine = "the quick brown fox jumps over the lazy dog "
			.repeat(6)
			.trim();
		const lines = Array.from({ length: 40 }, (_, i) => `${i + 1}: ${longLine}`);
		const text = lines.join("\n");

		const totalTokens = estimateTokens(text);
		expect(totalTokens).toBeGreaterThan(500);

		const chunks = splitLinesByTokenBudget(text, 200);
		expect(chunks.length).toBeGreaterThan(1);

		// 验证行号连续性：每块的 startLine 应等于上一块的 endLine + 1（首块除外）
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
		}

		// 首块从第 1 行开始
		expect(chunks[0]!.startLine).toBe(1);

		// 末块以最后一行结束
		expect(chunks[chunks.length - 1]!.endLine).toBe(lines.length);

		// 每块的 token 数不应显著超出预算（允许单行超出的情况）
		for (const chunk of chunks.slice(0, -1)) {
			// 非末块应在预算附近
			expect(chunk.tokens).toBeLessThanOrEqual(250); // 允许一些溢出
		}
	});

	it("单行超过预算时不会无限循环", () => {
		const hugeLine = "a ".repeat(1000); // 约 1000 token
		const text = `short\n${hugeLine}\nshort2`;
		const chunks = splitLinesByTokenBudget(text, 100);
		// 应能正常返回，不死循环
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		// 行号覆盖完整
		expect(chunks[0]!.startLine).toBe(1);
		expect(chunks[chunks.length - 1]!.endLine).toBe(3);
	});

	it("行号范围 1-based 且包含首尾", () => {
		const text = "a\nb\nc\nd\ne";
		const chunks = splitLinesByTokenBudget(text, 10000);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.startLine).toBe(1);
		expect(chunks[0]!.endLine).toBe(5);
	});
});
