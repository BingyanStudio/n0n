/**
 * DomainMessage — 领域消息类型（re-export 入口）
 *
 * 实际定义已拆分至 messages/ 子目录。
 * 此文件保留为向后兼容的 re-export 入口。
 *
 * 设计原则：
 * 1. 纯数据记录 — 只存储还原完整事件的必要信息，不包含任何提示词相关字段（role/content 等）。
 * 2. 严格类型 — 每种 DomainMessage 字段完整、无可选参数；用 discriminated union 表达变体，
 *    而非 `string | null` 妥协。
 * 3. 职责分离 — adapter 层（formatPrompt）负责将 DomainMessage 转换为 LLM 提示词格式。
 *    新增事件类型时只需定义新 DomainMessage + 对应 adapter case，互不耦合。
 * 4. 可持久化/可重放 — 纯数据结构天然支持序列化、存储和测试回放。
 */

export type * from "./messages/index.ts";
