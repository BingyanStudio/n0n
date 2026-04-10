/**
 * @n0n/core — Agent Loop 核心
 *
 * 只包含 agentLoop 核心循环 + 运行时配置。
 * 业务流水线（delegateTask、generate）在 @n0n/workflow。
 * 定时调度在 @n0n/scheduler。
 * 通用工具（workspace、skills、frontmatter）在 @n0n/shared。
 */

// Agent Loop
export type { AgentOptions, AgentResult } from "./agent/loop.ts";
export { agentLoop } from "./agent/loop.ts";

// 运行时上下文
export type {
	AgentConfig,
	RuntimeContext,
	RuntimeOptions,
	SecurityConfig,
} from "./runtime.ts";
export { createRuntimeContext, getRuntime, initRuntime } from "./runtime.ts";

// PlainRenderer（供需要默认渲染器的场景）
export { PlainRenderer } from "./ui/renderer.ts";

// Heartbeat
export {
	HeartbeatKeeper,
	HeartbeatState,
	realClock,
} from "./heartbeat/index.ts";
export type {
	Clock,
	HeartbeatCallbacks,
	HeartbeatConfig,
} from "./heartbeat/index.ts";
