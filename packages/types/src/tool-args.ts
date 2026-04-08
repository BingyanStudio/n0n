/**
 * 工具参数 Zod Schema — 全局领域契约（Single Source of Truth）
 *
 * 定义 LLM 与工具之间的参数契约：字段名、类型、可选性。
 * 所有消费方（工具执行器、渲染器、卡片构建等）统一从此处导入。
 *
 * 每个 schema 同时提供：
 * - 运行时校验（Zod parse）
 * - 编译期类型（z.infer）
 */

import { z } from "zod";

// ── exec ──

export const ExecArgsSchema = z.object({
	script: z.string(),
	runtime: z.string().optional(),
	cwd: z.string().optional(),
	// prompt cache 的 TTL 为 5 分钟，超时过长会导致缓存失效
	timeout: z.number().max(240).optional(),
});
export type ExecArgs = z.infer<typeof ExecArgsSchema>;

// ── write ──

export const WriteArgsSchema = z.object({
	path: z.string(),
	content: z.string(),
});
export type WriteArgs = z.infer<typeof WriteArgsSchema>;

// ── edit (shadow edit — 意图驱动) ──

export const EditArgsSchema = z.object({
	path: z.string(),
	intent: z.string(),
});
export type EditArgs = z.infer<typeof EditArgsSchema>;

// ── reminder ──

export const ReminderArgsSchema = z.object({
	content: z.string(),
	estimate: z.number().optional(),
});
export type ReminderArgs = z.infer<typeof ReminderArgsSchema>;

// ── submit ──

/** submit 参数不约束具体结构，由各场景的 schema 在后验证阶段校验 */
export const SubmitArgsSchema = z.record(z.string(), z.unknown());
export type SubmitArgs = z.infer<typeof SubmitArgsSchema>;
