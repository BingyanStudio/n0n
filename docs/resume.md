## 实现方案讨论

### 整体架构

我同意你的想法——**不插入 core**，而是在 `@n0n/shared` 中新增 `conversation-log` 子模块。这样做的好处是：
- 作为 shared 包的子模块，复用 shared 已有的依赖和基础设施
- 其他 app（如 `cli`、`fairy`）未来也可以使用
- core 保持纯净，只负责 agent loop

### 对话日志模块（合并到 `@n0n/shared`）

conversation-log 逻辑简单且仅依赖 `@n0n/types`，与 `shared` 定位一致，因此作为 `shared` 包的子模块而非独立包存在。代码位于 `packages/shared/src/conversation-log/`。

**职责**：
1. **序列化**：`DomainMessage[]` → JSON 文件（带元数据如时间戳、workspace 路径）
2. **反序列化**：JSON 文件 → `DomainMessage[]`
3. **文件命名**：生成标准文件名 `n0n-conversation-{timestamp}.json`

**导出的核心 API**：
```ts
import { saveConversation, loadConversation } from '@n0n/shared/conversation-log';

// 保存对话到文件
export function saveConversation(history: DomainMessage[], workspace: string, outputDir: string): string; // 返回文件路径

// 从文件加载对话
export function loadConversation(filePath: string): { history: DomainMessage[]; metadata: ConversationMetadata };
```

### `apps/code` 层的改动

1. **`cli.ts`**：增加 `--resume <file>` 和 `--save-every-loop` 选项解析
2. **`index.ts`**：将解析后的选项传递给 `startCodeRepl`
3. **`repl.ts`**：
   - `log` 命令：和 `exit` 一样作为特殊输入处理，调用 `saveConversation` 导出到工作区根目录
   - `--resume`：在 REPL 启动时从文件恢复 `history`
   - `--save-every-loop`：每次 `agentLoop` 返回后自动调用 `saveConversation`

### 具体问题

1. **导出文件位置**：`log` 命令导出到 `workspace` 根目录，文件名为 `n0n-conversation-{ISO时间戳}.json`
2. **`--resume` 恢复逻辑**：加载文件后直接用其中的 `history`，然后等待用户输入新消息继续对话
3. **`--save-every-loop` 的保存时机**：每次 agentLoop 结束后（无论成功/失败/中断），覆盖同一个文件还是每次新建？我倾向**覆盖同一个固定文件**（如 `n0n-conversation-latest.json`），这样方便调试