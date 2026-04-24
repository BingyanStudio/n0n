# n0n

> **自然语言驱动的 AI Agent 工作流引擎**  
> 通过精心设计的工具系统，在安全与灵活之间找到完美平衡

[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 核心设计：工具系统

n0n 的核心创新在于**工具设计**——每个工具都解决了一个特定的 Agent 痛点：

### 1. submit — 动态 Schema 驱动

**问题**：传统工具调用要么过于宽松（接受任意 JSON），要么过于僵化（固定参数结构），难以在安全与灵活之间平衡。

**解决方案**：`submit` 支持动态 Schema 注入：

```typescript
// 无 schema：宽松模式，接受任意结果
submit({ result: "任务完成", report: "创建了 3 个文件" })

// 有 schema：严格校验，字段直接展开到顶层
const schema = z.object({
  files_changed: z.array(z.string()),
  summary: z.string()
});
// LLM 直接生成：{ files_changed: [...], summary: "..." }
// 而非：{ result: { files_changed: [...], summary: "..." } }
```

**设计亮点**：
- Schema 属性直接展开到 `parameters` 顶层，LLM 获得每个字段的类型约束
- 类型安全与动态灵活并存：运行时 Zod 校验 + 编译时类型推导
- 单一工具，两种模式，无缝切换

---

### 2. edit — 委托模式避免重复定位

**问题**：传统编辑工具要求模型输出精确的 `old_string` 和 `new_string`，导致：
- 上下文浪费：模型需要输出完整代码片段
- 重复定位：模型定位一次，工具再定位一次
- 容错性差：一个字符不匹配就失败

**解决方案**：`edit` 采用**意图驱动 + Agent 委托**模式：

```typescript
// 主模型只需描述"改什么"，不需要输出代码
edit({ 
  path: "src/config.ts", 
  intent: "Change TIMEOUT from 5000 to 10000" 
})
```

内部委托给 **Editor Agent**，它负责：
1. 解析意图，定位目标代码
2. 执行精确的 `str_replace` 操作
3. 返回修改结果 + 对意图质量的反馈

**设计亮点**：
- **避免重复定位**：主模型提供语义描述，Editor Agent 负责精确定位
- **反馈学习**：Editor Agent 评估 intent 质量，帮助主模型优化未来的请求
- **提示词负载迁移**：复杂的编辑逻辑交给 Editor Agent，主模型上下文保持简洁
- **上下文中学习**：通过反馈机制，主模型逐步学会写出更好的 intent

---

### 3. reminder — 交错思考的独特设计

**问题**：Agent 在长任务中容易：
- 陷入局部最优，忘记全局目标
- 承诺过多，执行过少
- 思维定势，重复错误路径

**解决方案**：`reminder` 实现**承诺-反思循环**：

```typescript
reminder({
  content: `
    Objective: 重构用户认证模块
    Key Results: [ ] 分析现有代码 [ ] 设计新架构 [ ] 实现迁移
    Current: 分析阶段，发现 3 个问题
    Next: 查阅最佳实践文档
  `,
  delay: 7  // 承诺 7 轮内完成当前阶段
})
```

**机制**：
1. `delay` 是一个**承诺**：Agent 承诺在 N 轮内完成当前阶段
2. 到期时系统注入 `<reminder>` 标签，触发**强制反思**
3. Agent 必须输出 `<reflection>` 分析为何未达成，然后设置新的 reminder

**设计亮点**：
- **OKR 结构化**：Objective + Key Results + Current Progress，强制清晰规划
- **User Message 重置**：reminder 以 user message 形式注入，定期打断模型的交错思考积累，避免陷入思维定势
- **自我约束**：未完成承诺必须反思，形成正向压力
- **保守估计激励**：描述中明确"提前完成优于打破承诺"

---

### 4. exec — 编程化调用 + Skills 组合

**问题**：传统 shell 调用：
- 多次往返，每次推理开销大
- 中间结果污染上下文
- 引号转义、跨平台兼容等工程问题

**解决方案**：`exec` 支持**多运行时 + 单次脚本编排**：

```typescript
// ❌ 传统方式：多次往返
exec("ls src")
exec("cat package.json") 
exec("grep version")
// 大量中间结果进入 context

// ✅ exec 方式：单次脚本，处理后再返回
exec({ runtime: "bun", script: `
  import { readdir, readFile } from 'node:fs/promises';
  const files = await readdir("./src", { recursive: true });
  const tsFiles = files.filter(f => f.endsWith(".ts"));
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  console.log({ 
    tsFiles: tsFiles.length, 
    version: pkg.version,
    top5: tsFiles.slice(0, 5) 
  });
` })
// 只有汇总结果进入 context
```

**多运行时支持**：
| 类别 | Runtime | 用途 |
|------|---------|------|
| Shell | `cmd`(Win) / `sh`(Unix) | 系统命令、管道操作 |
| Shell | `pwsh` | 跨平台、对象管道 |
| JS/TS | `bun`(推荐), `node` | 数据处理、JSON 解析、文件转换 |
| Python | `uv`, `python` | 数据分析、AI 库调用 |

**设计亮点**：
- **临时文件执行**：脚本写入临时文件后执行，彻底消除引号转义问题
- **跨平台一致**：所有平台行为一致，无需关心底层差异
- **Skills 组合**：通过 exec 可以调用任意脚本，结合 Skills 系统实现无限制扩展
- **上下文优化**：在脚本内部处理数据，只返回必要结果

---

## 架构概览

```
用户输入
   ↓
┌──────────────────────────────────────────┐
│  信息增强（记忆 / Skills / 历史记录）      │
└────────────────┬─────────────────────────┘
                 ↓
┌──────────────────────────────────────────┐
│  Agent Loop                              │
│  ┌────────────────────────────────────┐  │
│  │ LLM 调用                           │  │
│  │     ↓                              │  │
│  │ Tool Calls                         │  │
│  │ ├─ exec  → 脚本执行（多运行时）      │  │
│  │ ├─ write → 文件创建                │  │
│  │ ├─ edit  → 意图驱动编辑（委托）      │  │
│  │ ├─ reminder → 承诺-反思循环         │  │
│  │ └─ submit → 结果提交（动态Schema）   │  │
│  │     ↓                              │  │
│  │ Zod Schema 校验                     │  │
│  │ 最多 4 次重试                       │  │
│  └────────────────────────────────────┘  │
└────────────────┬─────────────────────────┘
                 ↓
      TypeScript Workflow 文件
      workflows/tasks/xxx.ts
```

---

## 项目结构

```
n0n/
├── packages/          # 核心库
│   ├── types/         # DomainMessage 类型定义
│   ├── llm/           # LLM 客户端（多 Provider、SSE 流式）
│   ├── tools/         # 核心工具（exec/write/edit/reminder/submit）
│   ├── core/          # Agent Loop 核心引擎
│   ├── shared/        # Skills 发现、对话持久化
│   ├── cli-ui/        # 共享终端渲染
│   └── multiline-input/ # 多行输入组件
│
├── apps/              # 应用入口
│   ├── code/          # 代码编辑 Agent
│   └── fairy/         # 独立 Agent 应用
│
└── scripts/           # 工具脚本
```

---

## 快速开始

```bash
# 安装依赖
bun install

# 配置环境变量
cat > .env << 'EOF'
LLM_BASE_URL=https://api.example.com
LLM_API_KEY=your-api-key-here
LLM_MODEL=deepseek/deepseek-v3.2
LLM_ENABLE_THINKING=true
LLM_PROVIDER=openai-compatible
PROVIDER=openai-compatible
EDITOR_LLM_BACKEND_PROVIDER=openai-compatible
EOF

# 启动交互式 REPL
bun start

# 代码编辑 Agent
bun start:code

# 直接传入任务
bun start "每天早上总结 Hacker News 热门"
```

---

## API 层级

| API | 用途 | 说明 |
|-----|------|------|
| `generate<T>()` | 轻量生成 | 走 agentLoop，跳过咨询 + RAG |
| `delegateTask<T>()` | 完整流水线 | 咨询 → RAG → agentLoop |
| `agentLoop<T>()` | 底层 API | 完全控制 `DomainMessage[]` |

---

## 环境变量

### LLM（必需）

| 变量 | 说明 |
|------|------|
| `LLM_BASE_URL` | OpenAI 兼容 API 地址 |
| `LLM_API_KEY` | API 密钥 |
| `LLM_MODEL` | 模型标识（如 `deepseek/deepseek-v3.2`） |
| `LLM_ENABLE_THINKING` | 启用 Extended Thinking |
| `LLM_THINKING_BUDGET` | Thinking token 预算 |

### 路径覆盖（可选）

| 变量 | 默认值 |
|------|--------|
| `WORKFLOWS_DIR` | `workflows` |
| `SKILLS_DIR` | `workflows/skills` |
| `MEMORY_DIR` | `workflows/memory` |

### 示例
```env                                                             
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
LLM_BASE_URL=https://api.example.com/
LLM_API_KEY=sk_xxx
LLM_MODEL=deepseek/deepseek-v3.2
LLM_ENABLE_THINKING=true
LLM_PROVIDER=openai-compatible
PROVIDER=openai-compatible
EDITOR_LLM_BACKEND_PROVIDER=openai-compatible
```

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | [Bun](https://bun.sh) |
| 语言 | TypeScript (strict mode) |
| Monorepo | [Turborepo](https://turbo.build) |
| Lint | [Biome](https://biomejs.dev) |
| Schema | [Zod](https://zod.dev) |

---

## 核心文档

| 文档 | 内容 |
|------|------|
| [AGENTS.md](AGENTS.md) | 开发规范与协作原则 |
| [prompt-design-principles.md](docs/prompt-design-principles.md) | 提示词设计原则 |
| [docs/reference/](docs/reference/) | 第三方 API 参考（飞书、Skills） |

---

## 开发

```bash
# 类型检查
bun run typecheck

# Lint + 自动修复
bun run lint

# 单独启动某个 app
bun run apps/code/src/cli.ts
```

---

## License

MIT
