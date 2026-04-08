import { describe, expect, it } from "bun:test";
import { deepParseJsonStrings } from "../deep-parse-json-strings.ts";

describe("deepParseJsonStrings", () => {
	it("普通字符串原样返回", () => {
		expect(deepParseJsonStrings("hello")).toBe("hello");
	});

	it("非字符串基本类型原样返回", () => {
		expect(deepParseJsonStrings(42)).toBe(42);
		expect(deepParseJsonStrings(true)).toBe(true);
		expect(deepParseJsonStrings(null)).toBeNull();
	});

	it("JSON 数组字符串 → 解析为数组", () => {
		const input = '[{"a":1},{"a":2}]';
		const result = deepParseJsonStrings(input);
		expect(result).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("JSON 对象字符串 → 解析为对象", () => {
		const input = '{"key":"value","num":3}';
		const result = deepParseJsonStrings(input);
		expect(result).toEqual({ key: "value", num: 3 });
	});

	it("对象字段中的 JSON 字符串 → 递归解析", () => {
		const input = {
			type: "ask_user",
			question: "Pick one",
			options: '[{"choice":"A","affect":"do A"}]',
		};
		const result = deepParseJsonStrings(input) as Record<string, unknown>;
		expect(result.type).toBe("ask_user");
		expect(result.question).toBe("Pick one");
		expect(result.options).toEqual([{ choice: "A", affect: "do A" }]);
	});

	it("数组元素中的 JSON 字符串 → 递归解析", () => {
		const input = ['{"a":1}', "plain", "[1,2,3]"];
		const result = deepParseJsonStrings(input);
		expect(result).toEqual([{ a: 1 }, "plain", [1, 2, 3]]);
	});

	it("无效 JSON 字符串（以 [ 或 { 开头但格式错误）→ 原样返回", () => {
		expect(deepParseJsonStrings("[not json")).toBe("[not json");
		expect(deepParseJsonStrings("{broken}")).toBe("{broken}");
	});

	it("多层嵌套 JSON 字符串 → 全部解析", () => {
		// 值本身是一个 JSON 字符串，解析后其内部字段又包含 JSON 字符串
		const inner = JSON.stringify({ nested: "[1,2]" });
		const result = deepParseJsonStrings(inner);
		expect(result).toEqual({ nested: [1, 2] });
	});

	it("空对象和空数组原样保留", () => {
		expect(deepParseJsonStrings({})).toEqual({});
		expect(deepParseJsonStrings([])).toEqual([]);
	});

	it("带空白的 JSON 字符串 → 正常解析", () => {
		const input = '  [1, 2, 3]  ';
		expect(deepParseJsonStrings(input)).toEqual([1, 2, 3]);
	});
});
