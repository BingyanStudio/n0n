# Shadow Edit：意图驱动的编辑架构

> 日期：2026-03-16 | 分支：feat/shadow-edit

## 问题

传统 search/replace 编辑模式的核心问题：

1. **旧内容重复**：模型读取文件（1次）→ search 抄写旧内容（2次）→ 注意力被旧代码吸引（3次）
2. **外在认知负荷**：任何固定格式 DSL（行号、hash、锚点）都要求模型做 `内部表征 → DSL 语法` 的翻译
3. **与 LLM 架构不匹配**：Transformer 的注意力机制是 content-based addressing，坐标寻址是非原生方式

## 探索历程

### 1. Line#Hash 方案

对每行内容生成 2-3 位 Base62 hash，用 `line#hash` 格式定位。

**验证结果**：技术可行（3位 hash 碰撞率 ~0%，多次编辑 3/3 正确定位），但存在体验问题：
- hash 是随机数，模型无法自主生成
- 需要两次读取（普通读 + 带 hash 读）
- hash 掺杂在代码中破坏阅读

### 2. 最小锚点方案

用内容子串（~15 字符）作为锚点，子串唯一匹配定位。

**验证结果**：模型自然写出的锚点 7/8 唯一，多行编辑 token 从 O(N) 降到 O(1)。但仍是固定格式 DSL。

### 3. 影子方案（最终方案）

取消固定格式，让主模型用自由文本表达编辑意图，影子层（小 LLM）负责理解并执行。

## 第一性原则

### 编辑的本质

```
edit : (Source, Intent) → Source'
MinSufficient(edit) = Anchor(unique_content_fragment) + Transform(target_state)
```

这个公式描述的是**信息量**，不是**表达形式**。同样的编辑意图可以用结构化 JSON、自然语言、代码片段或混合方式表达——信息量等价，区别在于谁来做解析。

### 六条设计原则

1. **内容即地址**：用内容本身定位，而非外部坐标
2. **锚点最小化**：只需足以消歧的最短片段
3. **目标状态完整性**：给出完整目标内容，而非差异描述
4. **语义边界对齐**：编辑范围与代码语义结构对齐
5. **幂等性**：同一指令应用两次结果相同
6. **失败可诊断性**：错误信息帮助模型自我修正

## 架构设计

### 双工具架构

保留原有 `edit`（Vim ex commands）作为确定性编辑工具，新增 `shadow_edit` 作为意图驱动编辑工具。

```
主模型可选择：
  edit        → Vim ex commands（确定性，适合简单/精确编辑）
  shadow_edit → 自由文本意图（灵活，适合复杂/语义级编辑）
```

### Shadow Edit 架构

```
主模型 → intent(自由文本) → 影子层(Editor LLM) → S'
                                                   ↓
                                              diff(S, S')
                                                   ↓
                                              返回主模型
```

- **主模型**：用最自然的方式表达编辑意图
- **影子层**：Editor LLM（小模型），专注于 apply(S, E) → S'
- **验证**：diff 返回给主模型确认

### Editor LLM 配置

```env
EDITOR_LLM_BASE_URL=...    # 不存在时 fallback 到 LLM_BASE_URL
EDITOR_LLM_API_KEY=...     # 不存在时 fallback 到 LLM_API_KEY
EDITOR_LLM_MODEL=...       # 必须配置
EDITOR_LLM_ENABLE_THINKING=true
```
