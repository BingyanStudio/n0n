# n0n 架构审计报告

> 审计时间：2026-02-28 | 分支：mvp | 代码量：~1916 LOC TypeScript (Bun)
> 对照文档：`docs/draft.md`（设计草案）、`docs/eval.md`（评估确认）

---

## 一、与最初目标的偏差总览

### 设计断言验证矩阵

从 draft.md + eval.md 提取 10 条核心设计断言，逐条对照实现：

| # | 设计断言 | 来源 | 状态 | 偏差分类 |
|---|---------|------|------|---------|
| A1 | TypeScript 代码作为 workflow，不用 DAG | draft §思路.1 | ✅ 通过 | — |
| A2 | subagent 是底层 agent loop，接收 `DomainMessage[]` | draft §技术决策 | ✅ 通过 | — |
| A3 | 工具集 4+1：exec/write/reminder/submit + read-media 后置 | eval §2.3 | ✅ 通过 | — |
| A4 | delegateTask 三步流水线：咨询→RAG→上下文组装 | draft §task库 | ✅ 通过 | — |
| A5 | 文件系统即注册表（skills/ + tasks/） | draft §使用场景 | ✅ 通过 | — |
| A6 | MDC 格式 cron scheduler | eval §补充 | ✅ 通过 | — |
| A7 | DomainMessage 判别联合，**无可选参数** | eval §2.4 | ⚠️ 轻微违反 | Violation |
| A8 | RAG 检索分空间，精准度递增（skill > memory > history） | draft §task库 | ⚠️ 简化 | Simplification |
| A9 | 定期反思：历史/workflow 被 review，提取记忆 | draft §使用场景 | ❌ 未实现 | Omission |
| A10 | Skill 注册流程（每个 monorepo 要有 README） | draft §使用场景 | ❌ 未实现 | Omission |

**总结：7/10 完全通过，1 轻微违反，1 简化，2 遗漏。Spec 忠实度约 85%。**

---

## 二、增强与补充细节（正面偏差）

以下偏差属于**对设计的合理增强**，建议保留：

### 2.1 workflow 列表主动推送

draft/eval 未提及，但 [`main.ts:interactiveLoop()`](src/main.ts:127) 和 [`delegate.ts`](src/task/delegate.ts:56) 在每次交互前并行扫描已有 workflow + schedule 并注入上下文，避免模型浪费轮次执行 `ls` 发现。

**评价**：减少了 agent 空转轮次，直接提升用户体验。✅ 保留。

### 2.2 `skipConsultation` 选项

[`delegate.ts`](src/task/delegate.ts:37) 支持跳过咨询步骤。draft 的三步流水线是固定流程，但实际场景中（如 `hn-daily-summary.ts` 每日定时执行），每次都咨询一遍浪费 token 且增加延迟。

**评价**：务实的工程决策。✅ 保留。

### 2.3 交互式 error 补充循环

[`main.ts:interactiveLoop()`](src/main.ts:147) 检测 `{ ok: false, error }` 后让用户补充信息继续——draft 只描述了 subagent 内部的 error 返回，未设计外层的多轮交互。

**评价**：显著提升了用户交互体验。✅ 保留。

### 2.4 options bag 替代位置参数

draft 的签名是 `subagent(history, schema?)`，实现改为 `subagent(history, options?)`。options bag 更可扩展（已用于 `maxIterations`）。

**评价**：标准的 API 设计演进。✅ 保留。

### 2.5 schedule 列表推送

交互时主动展示已有 schedules，避免 agent 重复注册相同定时任务。

**评价**：细节到位。✅ 保留。

---

## 三、错误 / 违背设计初心的设计

### 3.1 🔴 `executeTool` 对 unknown tool 伪造 ExecToolResult

**位置**：[`loop.ts:155-165`](src/agent/loop.ts:155)

```typescript
default:
  return {
    type: "tool_result",
    callId: tc.id,
    tool: "exec",        // ← 伪造为 exec
    command: "",
    exitCode: 1,
    stderr: `Unknown tool: ${tc.tool}`,
    // ...
  };
```

**问题**：当 LLM 调用了不存在的工具时，返回一个**伪造的** `ExecToolResult`。这直接违反了 eval §2.4 "DomainMessage 是判别联合，每种类型字段完整、语义明确"的原则——`tool: "exec"` 是假的，污染历史记录，类型系统被绕过，adapter 层会把它格式化为一条 exec 命令的输出误导后续 LLM 推理。

**修复**：为 `ToolResult` 添加 `ErrorToolResult` 变体（`tool: "unknown"`），在 adapter 中正确处理。**工作量：20 分钟。**

### 3.2 🔴 `delegateTask` 咨询步骤吞没致命错误

**位置**：[`delegate.ts:47-52`](src/task/delegate.ts:47)

```typescript
} catch {
  consultAdvice = "(consultation unavailable)";
}
```

所有异常（包括 401 Unauthorized、网络不通等致命错误）都被静默降级。如果 LLM 配置有误，用户不会看到任何错误提示，咨询静默跳过，执行步骤可能也会失败但错误信息完全不同，导致 debug 困难。

**修复**：区分可恢复错误（超时、429）和致命错误（401、配置错误），致命错误直接 throw。**工作量：15 分钟。**

### 3.3 ⚠️ DomainMessage 的 `string | null` 违反"无可选参数"原则

**位置**：[`domain.ts`](src/types/domain.ts)

eval §2.4 明确要求"字段不可选，语义明确"，但实现中有多处 `string | null`：

| 类型 | 字段 | 问题 |
|------|------|------|
| `AssistantToolCallMessage` | `content: string \| null` | LLM API 返回 null 时的妥协 |
| `WriteToolResult` | `error: string \| null` | 成功时为 null |
| `SubmitToolResult` | `report: string \| null` | 可选的报告 |

**建议**：`content` 改为 `string`（null → `""`），`WriteToolResult` 拆为 `WriteSuccessResult` / `WriteFailureResult`，`report` 改为 `string`（无报告时为空串）。**工作量：30 分钟。**

### 3.4 ⚠️ 泛型是装饰性的，没有类型推断链

**位置**：[`delegate.ts:26`](src/task/delegate.ts:26)、[`loop.ts:34`](src/agent/loop.ts:34)

`TaskResult<T = unknown>` 和 `AgentResult<T = unknown>` 声明了泛型参数，但 `result` 字段始终是 `unknown`。传入 Zod schema 后，校验通过的值仍然返回 `unknown`，workflow 作者需要手动 `as` 断言。

draft 签名 `SubagentResult<T>` 暗示 T 应该被推断。当前实现中泛型**完全没有作用**。

**评价**：不影响 MVP 功能，但评审看代码时可能质疑。低优先级。

### 3.5 ⚠️ 定期反思机制完全未实现

**来源**：draft §使用场景.定期反思

> "所有的推理历史 / 以及产出的 workflow 都会被 review，并且提取可用信息放进记忆中"

`workflows/memory/` 和 `workflows/history/` 目录仅有 `.gitkeep`。没有任何代码写入这些目录，也没有预制的反思 workflow。这是 draft 中描述的核心使用场景之一。

**建议**：实现 `workflows/tasks/reflect.ts` 预制 workflow，用 delegateTask 扫描 history 并生成 memory 摘要。**工作量：2-4 小时。**

---

## 四、代码坏味道 & 维护困难点

### 4.1 🔴 exec 工具无任何安全边界

**位置**：[`exec.ts`](src/tools/exec.ts)

`Bun.spawn(["sh", "-c", args.command])` 执行任意 shell 命令，无沙箱、无黑名单、无确认机制。当 scheduler 定时触发时，LLM 可以在无人监督下执行 `rm -rf /` 或 `curl | sh`。

评审几乎一定会问"你怎么防止 AI 执行危险命令"。

**最小修复**：添加基本命令黑名单 + 高危命令日志告警。**工作量：30 分钟。**

### 4.2 🟡 Scheduler 无并发锁，同一任务可能重复触发

**位置**：[`scheduler.ts:tick()`](src/scheduler/scheduler.ts:76)

每分钟 tick 对匹配的 schedule fire-and-forget。如果一个 workflow 执行超过 60 秒，下一次 tick 会再次触发同一个 schedule。Demo 演示时重复触发会显得不专业。

**修复**：
```typescript
const running = new Set<string>();
// 触发前检查：if (running.has(entry.name)) continue;
// 完成后：running.delete(entry.name);
```
**工作量：30 分钟。**

### 4.3 🟡 RAG 是"假 RAG"——纯 grep 关键词搜索

**位置**：[`rag.ts`](src/task/rag.ts)

1. **不是语义检索**：`grep -rl -i keyword`，无向量化、无嵌入
2. **中文完全失效**：`query.split(/\s+/)` 按空格分词，中文没有空格
3. **相关性硬编码**：history → `"low"`，其余 `"medium"`，没有基于匹配度排序
4. **draft 说"精准度递增"**（skill > memory > history），但 skill 和 memory 都是 `"medium"`

评审问"RAG 怎么实现的"时，回答"grep"会减分。

**建议分层**：
- **Must（2h）**：中文按字符 bigram 分词 + 按关键词命中数排序
- **Should（4h）**：grep 结果喂 LLM 做 rerank，可以说"LLM-as-judge reranking"

### 4.4 🟡 `subagent.ts` 是完全无逻辑的透传层

**位置**：[`subagent.ts`](src/agent/subagent.ts)

整个文件 8 行有效代码，`subagent()` 只是把参数透传给 `agentLoop()`，`SubagentOptions` 和 `AgentOptions` 几乎相同。公共 API 同时导出 `subagent` 和 `agentLoop`，增加认知负担。

**建议**：保留 `subagent` 作为公共 API（语义好），不导出 `agentLoop`（它是内部实现）。或者给 `subagent` 添加默认系统提示注入使其真正有别于裸 loop。**工作量：20 分钟。**

### 4.5 🟡 `discoverWorkflows` 依赖 Unix `find` 命令 + 同步 spawn

**位置**：[`runtime.ts`](src/workflow/runtime.ts:28)

`Bun.spawnSync(["find", ...])` 阻塞事件循环，且依赖 Unix 环境。Bun 有原生 `Glob` API 更惯用、跨平台。`rag.ts` 同样依赖 `grep` 命令。

**工作量：20 分钟。低优先级。**

### 4.6 🟡 `expectedReplaceTime` 命名误导

**位置**：[`definitions.ts`](src/tools/definitions.ts) + [`write.ts`](src/tools/write.ts)

`expectedReplaceTime` 实际含义是"期望的匹配次数"，不是"替换时间"。命名来自 draft（`expectedReplaceTime`），但 draft 本身就写错了。LLM 看到这个参数名可能理解为超时时间。

**建议**：重命名为 `expectedMatches`。**工作量：15 分钟。**

### 4.7 🟡 `config.ts` 模块加载时立即求值环境变量

**位置**：[`config.ts`](src/config.ts)

`requireEnv()` 在模块顶层执行，任何 import 链（包括 typecheck）都会触发。如果未来要写测试，需要在 import 前设置环境变量，否则直接 throw。MVP 阶段低优先级，但写测试时会成为障碍。

### 4.8 🟢 workflow 路径仍可能泄露绝对路径

**位置**：[`runtime.ts:discoverWorkflows()`](src/workflow/runtime.ts:43)

`path` 字段使用 `find` 返回的绝对路径，会在 LLM 上下文中暴露服务器文件系统结构（如 `/Users/wepie/Documents/...`）。intent tree 中 `I1.3.1` 说已修复，但 `path` 字段仍可能是绝对的。

**修复**：`path: path.relative(process.cwd(), file)`。**工作量：10 分钟。**

### 4.9 🟢 零测试覆盖

项目中没有任何 `.test.ts` 文件。[`cron.ts`](src/scheduler/cron.ts) 和 [`adapter.ts`](src/llm/adapter.ts) 都是纯函数，非常适合单元测试，且 Bun 内置测试运行器零配置。

**建议**：至少为 cron 解析器写 5-10 个用例。**工作量：1 小时。**

### 4.10 🟢 3 个 Demo workflow 可能未端到端验证

`workflows/tasks/` 下有 3 个 demo 文件，但从 git 历史看没有验证记录。比赛评审**最看重的是"能跑"**。

---

## 五、优先级行动建议（15 天冲刺）

### Week 1（Day 1-7）：修复 + 补全

| 优先级 | 行动项 | 对应编号 | 工作量 |
|--------|--------|---------|--------|
| 🔴 P0 | 修复 unknown tool 伪造 ExecToolResult | §3.1 | 20min |
| 🔴 P0 | 修复 delegateTask 咨询错误吞没 | §3.2 | 15min |
| 🔴 P0 | Scheduler 添加并发锁 | §4.2 | 30min |
| 🟡 P1 | 实现反思预制 workflow | §3.5 | 3h |
| 🟡 P1 | RAG 中文分词 + 命中数排序 | §4.3 | 2h |
| 🟡 P1 | cron.ts + adapter.ts 单元测试 | §4.9 | 1.5h |
| ⭐ P0 | **端到端跑通 3 个 Demo 场景** | §4.10 | Day 4-7 |

### Week 2（Day 8-15）：打磨 + 文档

| 优先级 | 行动项 | 对应编号 | 工作量 |
|--------|--------|---------|--------|
| 🟡 P1 | DomainMessage null → 空串/拆分类型 | §3.3 | 30min |
| 🟡 P1 | expectedReplaceTime → expectedMatches | §4.6 | 15min |
| 🟡 P1 | exec 添加基本命令黑名单 | §4.1 | 30min |
| 🟡 P1 | subagent 不导出 agentLoop | §4.4 | 20min |
| 🟢 P2 | workflow 路径改相对路径 | §4.8 | 10min |
| ⭐ P0 | README 完善 + Demo 录制 + 提交准备 | — | Day 11-15 |

### 明确不做

| 项目 | 原因 |
|------|------|
| 向量数据库 RAG | 工作量大，grep + rerank 足够 MVP |
| 多 LLM provider 适配 | eval.md 说"一个好模型跑全场" |
| 泛型类型推断链 | 不影响功能 |
| read-media 工具 | eval.md 已确认后置 |
| 上下文压缩 | eval.md 说"MVP 不做" |

---

## 六、总体评估

### 一句话

**架构设计优秀、Spec 忠实度高的 MVP。主要风险不在"做错了什么"，而在"还没做什么"——Demo 未验证、反思未实现、RAG 是 grep。**

### 评分卡

| 维度 | 分数 | 说明 |
|------|------|------|
| Spec 忠实度 | 4.5/5 | 核心架构完全符合，仅轻微偏差 |
| 代码质量 | 3.5/5 | 结构清晰，但有类型伪造、错误吞没等问题 |
| 可维护性 | 4/5 | 模块化好、职责分离清晰 |
| 交付就绪度 | 3/5 | Demo 文件存在但未验证，缺测试 |
| 创新性 | 4.5/5 | code-first workflow + AI 自扩展是强差异化 |

### 最大风险

1. **Demo 没跑通** — 比赛评审最看重"能跑"
2. **RAG 被追问** — 回答"grep"会减分
3. **反思机制缺失** — draft 核心场景之一

### 最大优势

1. **架构叙事完整** — draft → eval → impl 决策链清晰，答辩有说服力
2. **code-first 差异化** — 评委见惯了 DAG，TypeScript-as-workflow 是独特技术立场
3. **自扩展性自然成立** — AI 写 .ts = 注册 skill，import = 组合，无额外机制