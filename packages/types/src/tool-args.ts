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
	timeout: z.number().optional(),
});
export type ExecArgs = z.infer<typeof ExecArgsSchema>;

// ── write ──

export const WriteArgsSchema = z.object({
	path: z.string(),
	content: z.string(),
});
export type WriteArgs = z.infer<typeof WriteArgsSchema>;

// ── edit ──

export const EditArgsSchema = z.object({
	path: z.string(),
	commands: z.array(z.string()),
});
export type EditArgs = z.infer<typeof EditArgsSchema>;

// ── reminder ──

export const ReminderArgsSchema = z.object({
	content: z.string(),
	delay: z.number().optional(),
});
export type ReminderArgs = z.infer<typeof ReminderArgsSchema>;

// ── submit ──

export const SubmitArgsSchema = z.object({
	result: z.unknown(),
	report: z.string().optional(),
});
export type SubmitArgs = z.infer<typeof SubmitArgsSchema>;
