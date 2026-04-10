/**
 * Heartbeat 集成测试 — 验证心跳请求能命中 prompt cache
 *
 * 需要有效的 Anthropic 配置。环境变量未配置时自动跳过。
 *
 * 关键发现：Anthropic 自动缓存（请求顶层 cache_control）需要前缀 >= ~4096 tokens 才触发。
 * 测试使用 ~8k tokens 的上下文确保超过阈值。
 * 手动运行：N0N_INTEGRATION=1 bun test packages/llm/src/__tests__/heartbeat-integration.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { DomainMessage } from "@n0n/types";
import { buildLLMConfigFromEnv } from "../config-from-env.ts";
import { createLLMClient } from "../factory.ts";

function loadGlobalEnv(): boolean {
	try {
		const content = readFileSync(resolve(homedir(), ".n0n", ".env"), "utf-8");
		for (const line of content.split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			const eq = t.indexOf("=");
			if (eq < 0) continue;
			const key = t.slice(0, eq).trim();
			const value = t.slice(eq + 1).trim();
			if (key && !process.env[key]) process.env[key] = value;
		}
		return true;
	} catch {
		return false;
	}
}

/** 生成 ~8k tokens 的对话历史，确保超过 Anthropic 自动缓存的最小前缀阈值 */
function makeLargeContext(): DomainMessage[] {
	const msgs: DomainMessage[] = [
		{
			type: "system",
			content: "You are a senior software engineer specializing in TypeScript, systems design, and distributed systems. Provide thorough, detailed analysis with code examples when relevant.",
		},
	];

	const topics = [
		"implementing a circuit breaker pattern for microservice resilience with exponential backoff and jitter",
		"designing a write-ahead log for a distributed key-value store with crash recovery guarantees",
		"building a lock-free concurrent hash map using compare-and-swap operations in TypeScript",
		"implementing consistent hashing with virtual nodes for a distributed cache cluster",
		"designing an event sourcing system with CQRS pattern for a financial transaction platform",
		"building a rate limiter using the token bucket algorithm with Redis backend",
		"implementing a B-tree index for a database storage engine with page-level locking",
		"designing a gossip protocol for membership detection in a peer-to-peer network",
		"building a streaming SQL query engine with window functions and incremental aggregation",
		"implementing a Raft consensus algorithm for leader election in a replicated state machine",
		"designing a garbage collector with generational collection and concurrent marking phases",
		"building a type inference engine for a Hindley-Milner type system with let-polymorphism",
		"implementing a virtual DOM diffing algorithm with keyed reconciliation and batched updates",
		"designing a job scheduler with priority queues dependency graphs and resource constraints",
		"building a distributed tracing system with context propagation across async boundaries",
		"implementing a bloom filter with optimal hash function count for probabilistic set membership",
		"designing a connection pool manager with health checks idle timeout and connection draining",
		"building an incremental parser for a programming language with error recovery and partial ASTs",
		"implementing a memory allocator with buddy system free list and coalescing for embedded systems",
		"designing a pub-sub message broker with topic-based routing persistent queues and backpressure",
		"building a reactive state management system with fine-grained dependency tracking and batch updates",
		"implementing a zero-copy deserialization framework for high-throughput network protocols",
		"designing a multi-tenant database isolation layer with row-level security and resource quotas",
		"building a distributed lock manager with fencing tokens and deadlock detection algorithms",
		"implementing a log-structured merge tree storage engine with compaction strategies",
		"designing a service mesh sidecar proxy with circuit breaking and mutual TLS authentication",
		"building a real-time collaborative editing system with operational transformation conflict resolution",
		"implementing a custom memory pool allocator with thread-local caches for game engine performance",
		"designing a CDC pipeline with exactly-once delivery guarantees and schema evolution support",
		"building a query optimizer with cost-based plan selection and statistics-driven cardinality estimation",
		"implementing a WebAssembly runtime with ahead-of-time compilation and sandboxed execution",
		"designing a feature flag system with gradual rollout percentage-based targeting and kill switches",
		"building a distributed file system with erasure coding replication and automatic rebalancing",
		"implementing a custom profiler with sampling-based stack trace collection and flame graph generation",
		"designing a workflow engine with saga pattern compensation and idempotent step execution",
		"building a time-series database with columnar storage and downsampling aggregation policies",
		"implementing a network protocol with congestion control sliding windows and selective acknowledgments",
		"designing an access control system with attribute-based policies and hierarchical role inheritance",
		"building a search engine with inverted index BM25 scoring and faceted navigation support",
		"implementing a container orchestrator with resource scheduling affinity rules and health monitoring",
	];

	for (let i = 0; i < topics.length; i++) {
		msgs.push({
			type: "user_input",
			content: `Please explain the key design considerations and tradeoffs involved in ${topics[i]}. Include relevant data structures, algorithms, and potential pitfalls to avoid in production.`,
			context: null,
			hint: null,
		});
		msgs.push({
			type: "assistant_text",
			content: `When ${topics[i]}, there are several critical factors to consider. First, you need to evaluate the consistency vs availability tradeoffs per the CAP theorem. The implementation should handle partial failures gracefully, maintain linearizability where required, and provide clear observability into system state. Key metrics to monitor include p99 latency, throughput under contention, memory overhead per operation, and failure recovery time. For the data structure choice, consider the access patterns, expected cardinality, and cache locality requirements of your specific workload. Additionally, consider the operational complexity: deployment strategies, monitoring dashboards, alerting thresholds, runbook documentation, and incident response procedures. The testing strategy should include unit tests with deterministic scheduling, integration tests with fault injection, chaos engineering experiments, and load tests that simulate realistic production traffic patterns with varying request distributions.`,
		} as DomainMessage);
	}

	msgs.push({
		type: "user_input",
		content: "Now summarize the common themes across all these distributed systems patterns.",
		context: null,
		hint: null,
	});

	return msgs;
}

describe("heartbeat integration", () => {
	const loaded = loadGlobalEnv();
	const isAnthropic = process.env.LLM_PROVIDER === "anthropic";
	const integrationEnabled = process.env.N0N_INTEGRATION === "1";

	test.skipIf(!loaded || !isAnthropic || !integrationEnabled)(
		"stream 建立缓存 → heartbeat 命中缓存",
		async () => {
			const config = buildLLMConfigFromEnv("LLM");
			const client = createLLMClient(config);

			expect(client.heartbeat).toBeDefined();
			if (!client.heartbeat) return;

			const messages = makeLargeContext();
			const request = {
				messages,
				tools: [
					{
						name: "exec",
						description: "Execute a command",
						parameters: {
							type: "object" as const,
							properties: { script: { type: "string" } },
							required: ["script"],
						},
					},
				],
				toolChoice: "auto" as const,
			};

			// Round 1: stream 建立缓存
			console.log("  [1/2] stream (建立缓存)...");
			let streamUsage = null;
			for await (const event of client.stream(request)) {
				if (event.type === "done") streamUsage = event.usage;
			}
			console.log("  stream:", JSON.stringify(streamUsage));
			expect(streamUsage).not.toBeNull();
			expect(streamUsage!.cacheWriteTokens).toBeGreaterThan(0);

			// Round 2: heartbeat 命中缓存
			console.log("  [2/2] heartbeat (应命中缓存)...");
			const hbUsage = await client.heartbeat(request);
			console.log("  heartbeat:", JSON.stringify(hbUsage));

			expect(hbUsage).not.toBeNull();
			expect(hbUsage!.outputTokens).toBeLessThanOrEqual(2);
			expect(hbUsage!.cacheReadTokens).toBeGreaterThan(0);
		},
		60_000,
	);
});
