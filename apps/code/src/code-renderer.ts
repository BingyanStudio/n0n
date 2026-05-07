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
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { RichRenderer } from "@n0n/cli-ui";
import type { BaseWorkspacePaths } from "@n0n/shared";
import type { ToolCallRecord } from "@n0n/types";
import { parse as parsePartialJSON } from "partial-json";

/** 流式预览模式 — 基于字段到达顺序 */
type PreviewMode = "unknown" | "path-first" | "content-first";

/** 单个 write 工具调用的流式预览状态 */
interface WritePreview {
	/** 累积的 JSON 参数字符串 */
	args: string;
	/** 解析出的目标文件路径。path-first 模式下，path 值在 content 出现前持续更新，content 出现后锁定；content-first 模式下始终为 null */
	targetPath: string | null;
	/** 字段到达顺序判定 */
	mode: PreviewMode;
	/** content-first 模式下使用的临时预览路径 */
	tempPreviewPath: string | null;
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

	constructor(private readonly paths: BaseWorkspacePaths) {
		super();
	}

	override toolCallArgStart(index: number, name: string): void {
		super.toolCallArgStart(index, name);
		if (name === "write") {
			this.previews.set(index, {
				args: "",
				targetPath: null,
				mode: "unknown",
				tempPreviewPath: null,
				lastContentLength: -1,
				lastWriteTime: 0,
			});
		}
	}

	override toolCallArgChunk(index: number, chunk: string): void {
		super.toolCallArgChunk(index, chunk);

		const preview = this.previews.get(index);
		if (preview) {
			preview.args += chunk;
			this.flushPreview(index, preview, false);
		}
	}

	override toolCallArgEnd(index: number, tc: ToolCallRecord): void {
		super.toolCallArgEnd(index, tc);

		if (tc.tool === "write") {
			const filePath = this.resolvePath(tc.args.path);
			this.writeFile(filePath, tc.args.content);
		}
		this.previews.delete(index);
	}

	override streamEnd(): void {
		// 安全网：清理所有未完成的预览（如流被截断）
		for (const [index, preview] of this.previews.entries()) {
			this.flushPreview(index, preview, true);
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
	private flushPreview(index: number, preview: WritePreview, force: boolean): void {
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

		const hasPath = typeof parsed.path === "string" && parsed.path.length > 0;
		const hasContent = typeof parsed.content === "string";

		// 首次信号判定 mode
		if (preview.mode === "unknown") {
			if (hasPath && !hasContent) {
				// path 先到 — path-first，但 targetPath 会在后续持续更新
				preview.mode = "path-first";
			} else if (hasContent && !hasPath) {
				// content 先到 — 使用临时预览路径，永不锁定 path
				preview.mode = "content-first";
				preview.tempPreviewPath = resolve(
					this.paths.temp,
					"write-stream-previews",
					`write-stream-preview-${index}`,
				);
			} else if (hasPath && hasContent) {
				// 同时出现 — path 应已完整，直接锁定
				preview.mode = "path-first";
				preview.targetPath = this.resolvePath(parsed.path as string);
			}
			// 两者都未出现 → 保持 unknown，等待更多数据
		}

		// path-first 模式下，content 未出现前持续更新 targetPath
		if (preview.mode === "path-first" && hasPath && !hasContent) {
			preview.targetPath = this.resolvePath(parsed.path as string);
		}

		// 写入路由
		if (hasContent) {
			if (preview.mode === "path-first" && preview.targetPath) {
				if ((parsed.content as string).length !== preview.lastContentLength) {
					preview.lastContentLength = (parsed.content as string).length;
					preview.lastWriteTime = now;
					this.writeFile(preview.targetPath, parsed.content as string);
				}
			} else if (preview.mode === "content-first" && preview.tempPreviewPath) {
				if ((parsed.content as string).length !== preview.lastContentLength) {
					preview.lastContentLength = (parsed.content as string).length;
					preview.lastWriteTime = now;
					this.writeFile(preview.tempPreviewPath, parsed.content as string);
				}
			}
		}
	}

	private resolvePath(p: string): string {
		return isAbsolute(p) ? p : resolve(this.paths.workspace, p);
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
