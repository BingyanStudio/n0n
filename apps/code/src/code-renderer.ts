/**
 * CodeRenderer — code app 特化渲染器
 *
 * 继承 RichRenderer 的全部终端渲染能力，额外增加：
 * - write 工具流式预览：在参数流式传输过程中，增量解析 partial JSON，
 *   将已有的 content 实时写入目标文件，让编辑器自动检测变化实现实时预览。
 *
 * 设计原则：
 * - 利用指令式事件模型，不新增 Renderer 接口
 * - 改动封闭在 code app 内，不影响核心包和其他 app
 * - 未来可扩展：如 edit 工具的实时 diff 预览（当前仅 write）
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { RichRenderer } from "@n0n/cli-ui";
import type { ToolCallRecord } from "@n0n/types";
import { parse as parsePartialJSON } from "partial-json";

/** 单个 write 工具调用的流式预览状态 */
interface WritePreview {
	/** 累积的 JSON 参数字符串 */
	args: string;
	/** 解析出的目标文件路径（content key 出现后锁定，避免 partial-json 截断值） */
	targetPath: string | null;
	/** 上一次写入的 content 长度（用于去重，避免内容未变时重复写入） */
	lastContentLength: number;
	/** 上一次写入时间戳（用于节流） */
	lastWriteTime: number;
}

/** 写入节流间隔（ms）— 避免过于频繁的磁盘写入 */
const THROTTLE_MS = 100;

export class CodeRenderer extends RichRenderer {
	/** 活跃的 write 预览（index → preview state） */
	private previews = new Map<number, WritePreview>();

	constructor(private readonly workspace: string) {
		super();
	}

	override toolCallArgStart(index: number, name: string): void {
		super.toolCallArgStart(index, name);
		if (name === "write") {
			this.previews.set(index, {
				args: "",
				targetPath: null,
				lastContentLength: -1,
				lastWriteTime: 0,
			});
		}
	}

	override toolCallArgChunk(index: number, chunk: string): void {
		super.toolCallArgChunk(index, chunk);

		const preview = this.previews.get(index);
		if (!preview) return;

		preview.args += chunk;
		this.flushPreview(preview, false);
	}

	override toolCallArgEnd(index: number, tc: ToolCallRecord): void {
		super.toolCallArgEnd(index, tc);

		// 最终确认写入（绕过节流）
		if (tc.tool === "write") {
			const filePath = this.resolvePath(tc.args.path);
			this.writeFile(filePath, tc.args.content);
		}
		this.previews.delete(index);
	}

	override streamEnd(): void {
		// 安全网：清理所有未完成的预览（如流被截断）
		// 对未完成的 write，做一次最终 flush
		for (const preview of this.previews.values()) {
			this.flushPreview(preview, true);
		}
		this.previews.clear();
		super.streamEnd();
	}

	override aborted(): void {
		this.previews.clear();
		super.aborted();
	}

	// ── 内部方法 ──

	/**
	 * 从累积的 partial JSON 中提取 path/content，写入目标文件。
	 * @param force 是否强制写入（跳过节流，用于 streamEnd/argEnd）
	 */
	private flushPreview(preview: WritePreview, force: boolean): void {
		// 节流：距上次写入不足阈值则跳过
		const now = Date.now();
		if (!force && now - preview.lastWriteTime < THROTTLE_MS) return;

		let parsed: Record<string, unknown> | null = null;
		try {
			const result = parsePartialJSON(preview.args);
			if (result && typeof result === "object" && !Array.isArray(result)) {
				parsed = result as Record<string, unknown>;
			}
		} catch {
			return;
		}
		if (!parsed) return;

		// 提取 path — 仅当 content key 已出现时才锁定
		// partial-json 会为未闭合的字符串值补全引号，导致 path 值可能是截断的
		// （如 {"path": "ts 被解析为 path:"ts"，实际应为 "tsconfig.json"）
		// 当 content key 出现时，说明 path 值已完整传输，此时锁定是安全的
		if (
			!preview.targetPath &&
			typeof parsed.path === "string" &&
			parsed.path &&
			"content" in parsed
		) {
			preview.targetPath = this.resolvePath(parsed.path);
		}

		// 提取 content 并写入
		if (preview.targetPath && typeof parsed.content === "string") {
			// 去重：content 长度未变说明本次 chunk 未增加 content 部分
			if (parsed.content.length !== preview.lastContentLength) {
				preview.lastContentLength = parsed.content.length;
				preview.lastWriteTime = now;
				this.writeFile(preview.targetPath, parsed.content);
			}
		}
	}

	private resolvePath(p: string): string {
		return isAbsolute(p) ? p : resolve(this.workspace, p);
	}

	private writeFile(filePath: string, content: string): void {
		try {
			const dir = dirname(filePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(filePath, content, "utf-8");
		} catch {
			// 预览写入失败不应中断渲染流程
		}
	}
}
