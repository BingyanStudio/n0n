/**
 * Patch 解析器 + 应用器
 *
 * 解析模型生成的 apply_patch 纯文本，应用到源文件。
 */

// ── 类型 ──

interface PatchSection {
	contextHint: string;
	lines: PatchLine[];
}

interface PatchLine {
	op: "context" | "add" | "remove";
	text: string;
}

interface PatchHunk {
	type: "update";
	sections: PatchSection[];
}

// ── 解析 ──

export function parsePatch(raw: string): PatchHunk | { error: string } {
	const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""));
	let i = 0;

	while (i < lines.length && lines[i] !== "*** Begin Patch") i++;
	if (i >= lines.length) return { error: "Missing *** Begin Patch" };
	i++;

	while (i < lines.length) {
		const l = lines[i] as string;
		if (l.startsWith("*** Update File:")) break;
		if (l === "*** End Patch") return { error: "No update hunk found" };
		i++;
	}
	if (i >= lines.length) return { error: "Missing *** Update File:" };
	i++;

	const sections: PatchSection[] = [];
	let currentSection: PatchSection | null = null;

	while (i < lines.length) {
		const line = lines[i] as string;

		if (line === "*** End Patch" || line.startsWith("*** ")) break;

		if (line === "@@" || line.startsWith("@@ ")) {
			currentSection = {
				contextHint: line === "@@" ? "" : line.slice(3),
				lines: [],
			};
			sections.push(currentSection);
			i++;
			continue;
		}

		if (
			currentSection &&
			line.length > 0 &&
			(line[0] === " " || line[0] === "+" || line[0] === "-")
		) {
			const op =
				line[0] === " " ? "context" : line[0] === "+" ? "add" : "remove";
			currentSection.lines.push({ op, text: line.slice(1) });
			i++;
			continue;
		}

		// patch 中空行，当作上下文空行（前缀空格可能被 trim）
		if (currentSection && line === "") {
			currentSection.lines.push({ op: "context", text: "" });
			i++;
			continue;
		}

		i++;
	}

	if (sections.length === 0) return { error: "No @@ sections found in patch" };
	return { type: "update", sections };
}

// ── 应用 ──

export function applyPatchToSource(
	source: string,
	hunk: PatchHunk,
): string | { error: string } {
	// CRLF 归一化：LLM 生成的 patch 只含 \n，需要统一处理
	const useCrlf = source.includes("\r\n");
	const normSource = useCrlf ? source.replace(/\r\n/g, "\n") : source;

	for (const section of hunk.sections) {
		for (const line of section.lines) {
			line.text = line.text.replace(/\r/g, "");
		}
	}

	const sourceLines = normSource.split("\n");

	for (const section of hunk.sections) {
		const matchLines = section.lines.filter(
			(l) => l.op === "context" || l.op === "remove",
		);

		if (matchLines.length === 0) {
			const addLines = section.lines
				.filter((l) => l.op === "add")
				.map((l) => l.text);
			sourceLines.push(...addLines);
			continue;
		}

		const found = findMatch(sourceLines, matchLines);
		if (found === -1) {
			const first = matchLines[0] as PatchLine;
			return {
				error: `Context not found: "${first.text}" (hint: "${section.contextHint}")`,
			};
		}

		const before = sourceLines.slice(0, found);
		let pos = found;
		for (const line of section.lines) {
			if (line.op === "context" || line.op === "remove") pos++;
			if (line.op === "context" || line.op === "add") before.push(line.text);
		}
		before.push(...sourceLines.slice(pos));

		sourceLines.length = 0;
		sourceLines.push(...before);
	}

	const result = sourceLines.join("\n");
	return useCrlf ? result.replace(/\n/g, "\r\n") : result;
}

function findMatch(
	sourceLines: string[],
	matchLines: PatchLine[],
): number {
	const first = (matchLines[0] as PatchLine).text;
	for (let j = 0; j < sourceLines.length; j++) {
		if (sourceLines[j] !== first) continue;
		let allMatch = true;
		for (let k = 0; k < matchLines.length; k++) {
			if (
				j + k >= sourceLines.length ||
				sourceLines[j + k] !== (matchLines[k] as PatchLine).text
			) {
				allMatch = false;
				break;
			}
		}
		if (allMatch) return j;
	}
	return -1;
}
