# Draft 评估报告

> 评估时间：2026-02-28 | 距离初赛截止：15 天

## 一、核心洞察评价

**"用 ts/js 代码作为 workflow"** 这个决策非常好：

1. **差异化明显**——评委见惯了拖拽式 DAG，code-first 是有说服力的技术立场
2. **AI 天然擅长写代码**——比生成 JSON/YAML 配置更可靠
3. **自扩展性自然成立**——写一个 .ts 文件就是注册一个 skill
4. **组合性免费获得**——import/export 就是 skill 组合

## 二、设计决策确认与补充

### 2.1 引擎层兜底：只管两件事

Agent 自己有能力判断和处理大部分执行错误——这本来就是 agent loop 的意义。引擎只需要兜底：

| 兜底场景 | 策略 |
|---------|------|
| 连续多轮无有效工具调用（空转） | 最大 5 次后终止 |
| 连续请求失败（网络层） | 退避重试，超限终止 |

其他的都是 agent 自己的职责：
- 进程超时 → agent 自己启动的进程自己清除
- 上下文太长 → 通过拆分任务解决，MVP 不做上下文压缩

### 2.2 预制 workflow ≠ 模板系统

反思、技能注册等本身就是预制的 workflow，和 AI 生成的 workflow 没有本质区别，不需要额外搞"模板引擎"。预制和生成的都是 .ts 文件，统一执行路径。

### 2.3 工具集：4+1 是对的

| 工具 | 状态 | 说明 |
|-----|------|------|
| `exec` | ✅ 核心 | 包含了 read 的能力（cat/grep/sed/head），不需要单独的 read 工具 |
| `write` | ✅ 核心 | search/replace 设计，空 search = 完整写入 |
| `reminder` | ✅ 核心 | 关键设计——agent 自我调节策略的手段，比 todo 更泛用，注入频率自决 |
| `submit` | ✅ 核心 | Result<T,E> 模式，调用方校验不通过则打回 |
| `read-media` | ⏳ 后置 | 多模态消息构造是模型约束，有价值但 MVP 可后置 |

### 2.4 DomainMessage：判别联合类型，不是大接口

DomainMessage 是**数据记录**，不是提示词。应该是判别联合类型（discriminated union），每种类型字段完整、无可选参数：

```typescript
// 示例：每种消息都是完整的、自描述的数据
type DomainMessage = 
  | SystemMessage 
  | UserMessage 
  | AssistantMessage 
  | ToolCallMessage 
  | ToolResultMessage

// 比如工具结果不是一个泛化的 { content: string }
// 而是具体的数据记录：
interface ExecToolResult {
  type: "tool_result"
  tool: "exec"
  command: string
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}
```

**原则**：
- 记录所有数据，字段不可选，语义明确
- 提示词转换由统一 adapter 层负责（DomainMessage → provider-specific format）
- 好处：避免 CoT 过长、toolcall/toolresult 不匹配、提示词缓存性能下降

## 三、架构全景

```
用户（自然语言）
       ▼
┌─ Engine Runtime ─────────────────────────┐
│                                           │
│  delegateTask 流水线：                     │
│    1. subagent 咨询（意图增强）            │
│    2. RAG 检索（memory/skill/history）    │
│    3. 上下文组装 → subagent 执行          │
│                                           │
│  Workflow 执行：                           │
│    TypeScript 代码，调用 subagent()        │
│    subagent 内部：exec / write / reminder / submit │
│                                           │
│  引擎兜底：                                │
│    - 空转检测（5轮无有效调用 → 终止）      │
│    - 网络失败检测（连续失败 → 退避/终止）  │
│                                           │
│  /workflows/skills/  ← 文件系统即注册表    │
│  /workflows/tasks/   ← ls + README 即发现  │
│                                           │
│  预制 workflow：反思、技能注册等            │
└───────────────────────────────────────────┘
```

## 四、已修正的笔误

1. ~~`type SearchSpace = "all" & "memory" & "skill" & "history"`~~ → `"all" | "memory" | "skill" | "history"`
2. ~~`delegateTask` 返回 `TaskResult<T>` 但下方定义为 `SubagentResult<T>`~~ → 统一为 `TaskResult<T>`

## 五、下一步

确认 demo 场景和 LLM 选型后，开始 Phase 1 脚手架和核心循环实现。
