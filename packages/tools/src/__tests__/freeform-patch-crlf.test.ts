/**
 * freeform-patch CRLF 归一化测试
 *
 * 验证 parsePatch 和 applyPatchToSource 能正确处理 CRLF 源文件。
 */

import { describe, expect, test } from "bun:test";
import {
	applyPatchToSource,
	parsePatch,
} from "../edit/freeform-patch/parser.ts";

const LF_SOURCE = "line1\nline2\nline3\nline4";
const CRLF_SOURCE = "line1\r\nline2\r\nline3\r\nline4";

const PATCH_TEXT = [
	"*** Begin Patch",
	"*** Update File: test.ts",
	"@@ context",
	" line2",
	"-line3",
	"+line3_modified",
	" line4",
	"*** End Patch",
].join("\n");

// 模拟 patch 本身也含 \r\n 的情况（某些 API 可能返回 CRLF）
const CRLF_PATCH_TEXT = PATCH_TEXT.replace(/\n/g, "\r\n");

describe("freeform-patch CRLF handling", () => {
	test("parsePatch handles LF patch text", () => {
		const result = parsePatch(PATCH_TEXT);
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.sections).toHaveLength(1);
	});

	test("parsePatch handles CRLF patch text", () => {
		const result = parsePatch(CRLF_PATCH_TEXT);
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.sections).toHaveLength(1);
	});

	test("applyPatchToSource works with LF source", () => {
		const hunk = parsePatch(PATCH_TEXT);
		if ("error" in hunk) throw new Error(hunk.error);

		const result = applyPatchToSource(LF_SOURCE, hunk);
		if (typeof result !== "string") throw new Error(result.error);

		expect(result).toBe("line1\nline2\nline3_modified\nline4");
		expect(result).not.toContain("\r");
	});

	test("applyPatchToSource works with CRLF source + LF patch", () => {
		const hunk = parsePatch(PATCH_TEXT);
		if ("error" in hunk) throw new Error(hunk.error);

		const result = applyPatchToSource(CRLF_SOURCE, hunk);
		if (typeof result !== "string") throw new Error(result.error);

		// 结果应保持 CRLF
		expect(result).toBe("line1\r\nline2\r\nline3_modified\r\nline4");
	});

	test("applyPatchToSource works with CRLF source + CRLF patch", () => {
		const hunk = parsePatch(CRLF_PATCH_TEXT);
		if ("error" in hunk) throw new Error(hunk.error);

		const result = applyPatchToSource(CRLF_SOURCE, hunk);
		if (typeof result !== "string") throw new Error(result.error);

		expect(result).toBe("line1\r\nline2\r\nline3_modified\r\nline4");
	});

	test("applyPatchToSource preserves LF when source is LF", () => {
		const hunk = parsePatch(PATCH_TEXT);
		if ("error" in hunk) throw new Error(hunk.error);

		const result = applyPatchToSource(LF_SOURCE, hunk);
		if (typeof result !== "string") throw new Error(result.error);

		expect(result).not.toContain("\r\n");
	});

	test("deletion in CRLF source", () => {
		const deletePatch = [
			"*** Begin Patch",
			"*** Update File: test.ts",
			"@@ context",
			" line2",
			"-line3",
			" line4",
			"*** End Patch",
		].join("\n");

		const hunk = parsePatch(deletePatch);
		if ("error" in hunk) throw new Error(hunk.error);

		const result = applyPatchToSource(CRLF_SOURCE, hunk);
		if (typeof result !== "string") throw new Error(result.error);

		expect(result).toBe("line1\r\nline2\r\nline4");
	});

	test("insertion in CRLF source", () => {
		const insertPatch = [
			"*** Begin Patch",
			"*** Update File: test.ts",
			"@@ context",
			" line2",
			"+line2.5",
			" line3",
			"*** End Patch",
		].join("\n");

		const hunk = parsePatch(insertPatch);
		if ("error" in hunk) throw new Error(hunk.error);

		const result = applyPatchToSource(CRLF_SOURCE, hunk);
		if (typeof result !== "string") throw new Error(result.error);

		expect(result).toBe("line1\r\nline2\r\nline2.5\r\nline3\r\nline4");
	});
});
