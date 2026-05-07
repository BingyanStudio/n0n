/**
 * Code Agent progress 结果 schema
 *
 * 三种 status：
 * - completed：任务完成，完整汇报
 * - working：阶段性进展，继续工作
 * - blocked：需要用户输入才能继续
 *
 * progress 是模型唯一能被用户看到的信息出口。
 * 所有字段描述均假定用户已失去上下文——内容必须完整且自包含。
 */

import { z } from "zod";

export const CodeProgressSchema = z.object({
	status: z.enum(["completed", "working", "blocked"]),
	content: z.string(),
});

export type CodeProgressResult = z.infer<typeof CodeProgressSchema>;
