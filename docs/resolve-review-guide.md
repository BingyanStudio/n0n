## 审校批注处理指南

本文档指导 AI agent 如何读取、分析和处理审校批注。

### 1. 读取批注

批注以 JSON 文件存储在 `wiki-docs/.annotations/` 目录下，每个文档对应一个文件。

**扫描所有待处理批注：**

```typescript
// bun runtime
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'path';

const dir = 'wiki-docs/.annotations';
const files = await readdir(dir).catch(() => []);

const allAnnotations = [];
for (const f of files) {
  if (!f.endsWith('.json')) continue;
  const data = JSON.parse(await readFile(join(dir, f), 'utf8'));
  const open = data.annotations.filter(a => a.status === 'open');
  if (open.length > 0) {
    allAnnotations.push({ file: data.filePath, annotations: open });
  }
}

for (const { file, annotations } of allAnnotations) {
  console.log(`\n📄 ${file} (${annotations.length} 条待处理)`);
  for (const a of annotations) {
    console.log(`  L${a.anchorLine ?? '?'} | "${a.selectedText}" → ${a.comment}`);
  }
}
```

**JSON 字段说明：**

| 字段 | 含义 |
|------|------|
| `selectedText` | 审校者选中的原文文本 |
| `comment` | 审校者的修改建议 |
| `anchorLine` | 选区所在的源文件行号（可能为 null） |
| `status` | `open` 待处理 / `resolved` 已解决 / `rejected` 已驳回 |

### 2. 概览与聚类

读取完所有批注后，**先做全局分析，不要逐条零散修复**：

```
第一步：按文件分组 — 哪些文件有批注？
第二步：按类型聚类 — 批注属于哪类问题？
  - 词条定义修正 → 需要修改定义源头（见第 3 节）
  - 公式修正 → 修改 %% 公式 %% 所在文件
  - 文案/措辞优化 → 直接修改对应行
  - 结构/逻辑调整 → 需要重组段落
第三步：识别 SSOT 关联 — 修改是否涉及被其他文档引用的词条？
```

### 3. SSOT 原则（Single Source of Truth）

本项目有两种词条定义方式：

#### 文件定义（主要方式）

一个 `.md` 文件就是一个词条。文件名即词条名，frontmatter 中可设别名和作用域：

```markdown
---
alias:
  - 别名A
  - 别名B
scope: 角色系统
---
这里是词条的定义内容...
```

文件正文就是定义内容。**大部分词条应该使用这种方式定义。**

#### 内联定义（临时方式）

在文档中用 `【词条名】：定义内容` 临时定义，适用于只在当前上下文有意义的概念：

```markdown
【暴击率】：玩家的暴击率，取值范围 0~1
```

#### 引用

任何地方使用 `【词条名】` 即可引用已定义的词条，悬停会显示定义卡片。

#### 修改原则

**当批注指出某个概念的描述有误时，必须找到该词条的定义源头修改，而不是在引用处手动改文本。**

```bash
# 查找词条的文件定义（文件名即词条名）
find wiki-docs/ -name "暴击率.md"

# 查找词条的内联定义
grep -rn "【暴击率】[：:]" wiki-docs/

# 查找公式定义
grep -rn "%%.* \[伤害\] .*%%" wiki-docs/
```

如果一个概念在多处被手动描述而没有使用 `【】` 引用，应该：
1. 为该概念创建词条文件（或内联定义）
2. 将各处手动描述替换为 `【词条名】` 引用

### 4. 组织修复计划

```
修复计划：
├── 定义层修改（影响全局，优先处理）
│   ├── 修改词条文件 wiki-docs/暴击率.md
│   └── 修改公式 %% ... %% @ 文件Y:行号
├── 文件级修改（按文件聚合，一次性改完）
│   ├── 文件X：批注 #1, #3, #5（同文件合并处理）
│   └── 文件Y：批注 #2, #4
└── 验证：修改后检查引用该词条的其他文件是否受影响
```

**每个文件的修改应该一次性完成**，避免对同一文件多次零散编辑。

### 5. 处理完成后更新状态

修复完成后，将对应批注标记为 `resolved`：

```typescript
import { readFile, writeFile } from 'node:fs/promises';

const data = JSON.parse(await readFile(annotationPath, 'utf8'));
for (const a of data.annotations) {
  if (fixedIds.includes(a.id)) {
    a.status = 'resolved';
    a.updatedAt = new Date().toISOString();
  }
}
await writeFile(annotationPath, JSON.stringify(data, null, 2));
```
