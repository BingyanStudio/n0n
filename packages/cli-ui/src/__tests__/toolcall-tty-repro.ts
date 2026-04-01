/**
 * TTY 复现脚本 v3：直接 instrument LiveRegion 追踪 lineCount
 */

const wasTTY = process.stderr.isTTY;
Object.defineProperty(process.stderr, "isTTY", { value: true, writable: true, configurable: true });

const { LiveRegion } = await import("../live-region.ts");
const { RichRenderer } = await import("../rich-renderer.ts");

// 恢复 TTY
if (wasTTY !== undefined) {
	Object.defineProperty(process.stderr, "isTTY", { value: wasTTY, configurable: true });
}

// ── Monkey-patch LiveRegion 追踪 lineCount ──
const origClear = LiveRegion.prototype.clear;
const origWriteln = LiveRegion.prototype.writeln;
const origReset = LiveRegion.prototype.reset;

const log: string[] = [];

LiveRegion.prototype.clear = function () {
	const lc = (this as any).lineCount;
	log.push(`    [LiveRegion.clear] lineCount=${lc} before clear`);
	origClear.call(this);
	log.push(`    [LiveRegion.clear] lineCount=${(this as any).lineCount} after clear`);
};

LiveRegion.prototype.writeln = function (text = "") {
	origWriteln.call(this, text);
	// 不打印每行细节，太多了
};

LiveRegion.prototype.reset = function () {
	const lc = (this as any).lineCount;
	log.push(`    [LiveRegion.reset] lineCount=${lc} → 0`);
	origReset.call(this);
};

// ── 静默 stderr（不实际输出） ──
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function () { return true; } as any;

// ══════════════════════════════════════════════════════════
// 场景 B：超 maxLines
// ══════════════════════════════════════════════════════════
log.push("═══ 场景B：超 maxLines 截断 ═══\n");

const renderer = new RichRenderer();

renderer.roundStart(1, 10, 3);
log.push("roundStart done\n");

renderer.toolCallArgStart(0, "write");
		renderer.toolCallArgChunk(0, '{"path":"output.txt","content":"');
log.push(`after path+content-start, streamRegion lineCount=${(renderer as any).streamRegion.lineCount}\n`);

for (let i = 1; i <= 20; i++) {
	const sep = i === 1 ? "" : "\\n";
	renderer.toolCallArgChunk(0, `${sep}line ${i}`);
	const lc = (renderer as any).streamRegion.lineCount;
	log.push(`after line-${String(i).padStart(2)}, streamRegion lineCount=${lc}\n`);
}

renderer.toolCallArgChunk(0, '"}');
log.push(`after close, streamRegion lineCount=${(renderer as any).streamRegion.lineCount}\n`);

renderer.streamEnd();
log.push(`after contentEnd, streamRegion lineCount=${(renderer as any).streamRegion.lineCount}\n`);

// ── 场景 A：多参数 ──
log.push("\n═══ 场景A：多参数细粒度 chunk ═══\n");

const renderer2 = new RichRenderer();
renderer2.roundStart(1, 10, 3);
log.push("roundStart done\n");

const chunks: [string | undefined, string][] = [
	["write", '{"'],
	[undefined, 'path":"'],
	[undefined, 'src/app.ts"'],
	[undefined, ',"content'],
	[undefined, '":"hello'],
	[undefined, ' world"'],
	[undefined, '}'],
];

for (let i = 0; i < chunks.length; i++) {
	const [name, arg] = chunks[i]!;
	if (name) renderer2.toolCallArgStart(0, name);
			renderer2.toolCallArgChunk(0, arg);
	const lc = (renderer2 as any).streamRegion.lineCount;
	log.push(`after chunk-${i} "${(name ?? "") + arg}", streamRegion lineCount=${lc}\n`);
}

renderer2.streamEnd();
log.push(`after contentEnd, streamRegion lineCount=${(renderer2 as any).streamRegion.lineCount}\n`);

// 恢复
process.stderr.write = origStderrWrite;

// 输出
for (const l of log) {
	console.log(l);
}
