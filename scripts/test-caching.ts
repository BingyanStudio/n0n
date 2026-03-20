/**
 * Prompt Caching 测试脚本
 * 
 * 通过 litellm gateway (OpenAI 兼容接口) 测试不同模型的 prompt caching 行为。
 * 
 * 测试方法：发送两次相同的长 system prompt 请求，观察第二次是否有 cache hit。
 * 
 * 用法: bun run scripts/test-caching.ts
 */

const BASE_URL = "https://ai-gateway.wepieoa.com";
const API_KEY = "$LLM_API_KEY";

// 生成一个足够长的 system prompt（> 1024 tokens）以触发缓存
const LONG_SYSTEM_PROMPT = [
  "You are an expert software engineer assistant.",
  "You help with code reviews, debugging, and architecture decisions.",
  "You follow these principles:",
  ...Array.from({ length: 50 }, (_, i) => 
    `${i + 1}. Principle ${i + 1}: Always consider edge cases, error handling, performance implications, and maintainability when writing code. Use descriptive variable names, write comprehensive tests, and document your reasoning. Follow the DRY principle and SOLID design patterns. Consider backward compatibility and migration paths for any changes.`
  ),
  "Always respond concisely.",
].join("\n");

console.log(`System prompt length: ~${LONG_SYSTEM_PROMPT.length} chars`);

// 测试模型列表
const MODELS = [
  { name: "GPT-4o (OpenAI)", model: "gpt-4o" },
  { name: "Claude Sonnet 4.6", model: "claude-sonnet-4-6" },
  { name: "Gemini 2.5 Flash", model: "gemini-2.5-flash" },
];

interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
  };
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

async function sendRequest(
  model: string,
  extraHeaders?: Record<string, string>,
): Promise<{ text: string; usage: UsageInfo; rawHeaders: Record<string, string>; rawUsage: unknown }> {
  const messages = [
    { role: "system", content: LONG_SYSTEM_PROMPT },
    { role: "user", content: "What is 2+2? Answer in one word." },
  ];

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 10,
    }),
    signal: AbortSignal.timeout(30000),
  });

  // 收集响应头
  const rawHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (/cache|token|usage|x-/i.test(k)) {
      rawHeaders[k] = v;
    }
  });

  const data = await res.json() as { choices: Array<{ message: { content: string } }>; usage: UsageInfo };
  return {
    text: data.choices?.[0]?.message?.content ?? "(no content)",
    usage: data.usage ?? {},
    rawHeaders,
    rawUsage: data.usage,
  };
}

async function testModel(config: { name: string; model: string }) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing: ${config.name} (${config.model})`);
  console.log("=".repeat(60));

  try {
    // 第一次请求（cache write）
    console.log("\n--- Request 1 (cache write) ---");
    const r1 = await sendRequest(config.model);
    console.log(`  Response: ${r1.text}`);
    console.log(`  Usage: ${JSON.stringify(r1.rawUsage, null, 2)}`);
    if (Object.keys(r1.rawHeaders).length > 0) {
      console.log(`  Headers: ${JSON.stringify(r1.rawHeaders, null, 2)}`);
    }

    // 等 2 秒让缓存生效
    await new Promise(r => setTimeout(r, 2000));

    // 第二次请求（cache read）
    console.log("\n--- Request 2 (cache read) ---");
    const r2 = await sendRequest(config.model);
    console.log(`  Response: ${r2.text}`);
    console.log(`  Usage: ${JSON.stringify(r2.rawUsage, null, 2)}`);
    if (Object.keys(r2.rawHeaders).length > 0) {
      console.log(`  Headers: ${JSON.stringify(r2.rawHeaders, null, 2)}`);
    }

    // 分析缓存行为
    console.log("\n--- Cache Analysis ---");
    const u1 = r1.usage;
    const u2 = r2.usage;

    // OpenAI style: prompt_tokens_details.cached_tokens
    if (u2.prompt_tokens_details?.cached_tokens) {
      console.log(`  ✅ OpenAI cache hit: ${u2.prompt_tokens_details.cached_tokens} cached tokens (was ${u1.prompt_tokens_details?.cached_tokens ?? 0})`);
    }

    // Anthropic style: cache_creation_input_tokens / cache_read_input_tokens
    if (u1.cache_creation_input_tokens !== undefined || u2.cache_read_input_tokens !== undefined) {
      console.log(`  R1 cache_creation: ${u1.cache_creation_input_tokens ?? "N/A"}, cache_read: ${u1.cache_read_input_tokens ?? "N/A"}`);
      console.log(`  R2 cache_creation: ${u2.cache_creation_input_tokens ?? "N/A"}, cache_read: ${u2.cache_read_input_tokens ?? "N/A"}`);
      if ((u2.cache_read_input_tokens ?? 0) > 0) {
        console.log(`  ✅ Anthropic cache hit!`);
      }
    }

    // 对比 prompt tokens
    console.log(`  R1 prompt_tokens: ${u1.prompt_tokens}, R2 prompt_tokens: ${u2.prompt_tokens}`);

  } catch (err) {
    console.error(`  ❌ Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 第二轮：测试 Anthropic 模型带 cache_control 标记
async function testAnthropicWithCacheControl() {
  console.log(`\n${"=".repeat(60)}`);
  console.log("Testing: Claude with explicit cache_control (litellm format)");
  console.log("=".repeat(60));

  const messages = [
    { 
      role: "system", 
      content: LONG_SYSTEM_PROMPT,
      // litellm 可能支持的 cache_control 格式
      cache_control: { type: "ephemeral" },
    },
    { role: "user", content: "What is 2+2? Answer in one word." },
  ];

  try {
    // 第一次
    console.log("\n--- Request 1 (with cache_control) ---");
    const res1 = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages,
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const d1 = await res1.json() as any;
    console.log(`  Usage: ${JSON.stringify(d1.usage, null, 2)}`);

    await new Promise(r => setTimeout(r, 2000));

    // 第二次
    console.log("\n--- Request 2 (with cache_control) ---");
    const res2 = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages,
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const d2 = await res2.json() as any;
    console.log(`  Usage: ${JSON.stringify(d2.usage, null, 2)}`);

    // 分析
    console.log("\n--- Cache Analysis ---");
    const u1 = d1.usage ?? {};
    const u2 = d2.usage ?? {};
    console.log(`  R1 cache_creation: ${u1.cache_creation_input_tokens ?? "N/A"}, cache_read: ${u1.cache_read_input_tokens ?? "N/A"}`);
    console.log(`  R2 cache_creation: ${u2.cache_creation_input_tokens ?? "N/A"}, cache_read: ${u2.cache_read_input_tokens ?? "N/A"}`);
  } catch (err) {
    console.error(`  ❌ Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 运行所有测试
for (const m of MODELS) {
  await testModel(m);
}

await testAnthropicWithCacheControl();

console.log("\n\nDone!");
