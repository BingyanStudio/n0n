/**
 * DomainMessage — 领域消息类型
 *
 * 设计原则：
 * 1. 纯数据记录 — 只存储还原完整事件的必要信息，不包含任何提示词相关字段（role/content 等）。
 * 2. 严格类型 — 每种 DomainMessage 字段完整、无可选参数；用 discriminated union 表达变体，
 *    而非 `string | null` 妥协。
 * 3. 职责分离 — adapter 层（formatPrompt）负责将 DomainMessage 转换为 LLM 提示词格式。
 *    新增事件类型时只需定义新 DomainMessage + 对应 adapter case，互不耦合。
 * 4. 可持久化/可重放 — 纯数据结构天然支持序列化、存储和测试回放。
 */

// ── User 侧 ──
export type {
	GenericSystemMessage,
	GenericUserTextMessage,
	UserInputMessage,
	UserImageMessage,
} from "./user.ts";

// ── Assistant 侧 ──
export type {
	AssistantTextMessage,
	AssistantToolCallMessage,
	GenericAssistantToolCallMessage,
	GenericToolResultMessage,
} from "./assistant.ts";

// ── Tool 侧 ──
export type {
	// 注册表
	ToolMap,
	ToolName,
	MakeCall,
	MakeResult,
	MakeResultBase,
	ToolCallRecord,
	ToolCallRecordMap,
	ExecToolCall,
	WriteToolCall,
	EditToolCall,
	ProgressToolCall,
	PartialToolCallRecord,
	// Exec
	ExecCompleted,
	ExecTruncated,
	ExecBackgrounded,
	ExecToolResult,
	// Write
	WriteCompleted,
	WriteFailed,
	WriteRecovered,
	WriteRecoverFailed,
	WriteToolResult,
	// Edit
	PatchOp,
	EditToolResult,
	// Progress
	ProgressToolResult,
	// 聚合
	ToolResult,
	ToolExecOutcome,
	ToolOutputChunk,
	ToolStreamEvent,
} from "./tools/index.ts";

// ── Error 侧 ──
export type {
	UnknownToolError,
	InvalidArgsError,
	TruncatedRecoveryError,
	InternalExecutionError,
	ToolError,
	ToolArgErrorMessage,
} from "./errors.ts";

// ── 元数据/控制 ──
export type {
	TurnFeedbackMessage,
	IdleNudgeMessage,
	CacheBreakpointMessage,
	TokenUsageMessage,
} from "./base.ts";

// ── 调度 ──
export type { CanStartFn } from "./scheduling.ts";

// ── DomainMessage 联合类型 ──

import type {
	GenericSystemMessage,
	GenericUserTextMessage,
	UserInputMessage,
	UserImageMessage,
} from "./user.ts";
import type {
	AssistantTextMessage,
	AssistantToolCallMessage,
	GenericAssistantToolCallMessage,
	GenericToolResultMessage,
} from "./assistant.ts";
import type { ToolResult } from "./tools/index.ts";
import type { ToolArgErrorMessage } from "./errors.ts";
import type {
	TurnFeedbackMessage,
	IdleNudgeMessage,
	CacheBreakpointMessage,
	TokenUsageMessage,
} from "./base.ts";

/** 领域消息主干联合 */
export type DomainMessage =
	// 基础交互
	| GenericSystemMessage
	| GenericUserTextMessage
	| UserInputMessage
	| UserImageMessage
	// 模型输出
	| AssistantTextMessage
	| AssistantToolCallMessage
	| GenericAssistantToolCallMessage
	| GenericToolResultMessage
	// 工具执行生命周期
	| ToolResult
	| ToolArgErrorMessage
	// 流程控制与元数据
	| TurnFeedbackMessage
	| IdleNudgeMessage
	| CacheBreakpointMessage
	| TokenUsageMessage;
