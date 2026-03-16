# 1
## 问题现场
▸ edit
  ├ intent
  │ 修复 CodeBlock 的处理：添加 entering 检查，只在 entering=true 时处理一次。同时修复 Strong 标签，使用 `<b>` 标签并添加 font-weight:bold 样式以确保在公众号编辑器中正确显示。
  ├ path
  │ ShareFlow/internal/util/wx_render/render.go
  ├──────────────────────────────
◂ edit ShareFlow/internal/util/wx_render/render.go: Failed after 3 attempts. Last error: All operations failed:
Search text not found: "        case blackfriday.CodeBlock:
                text := string(node.Literal)
                lang := ""
                if no..."
Search text not found: "        case blackfriday.Strong:
                if entering {
                        _, _ = w.Write([]byte(fmt.Sprintf("..."

## 问题所在：

模型错误的判断了 edit 命令的任务粒度，该替换任务非常复杂，应该使用edit进行多次编辑，而不是尝试一次性完成。

使用：
1. 修复 CodeBlock 的处理：添加 entering 检查，只在 entering=true 时处理一次。
2. 修复 Strong 标签，使用 `<b>` 标签并添加 font-weight:bold 样式以确保在公众号编辑器中正确显示。

分为两步即可调用成功。

且工具报错返回不友好，无法指导模型正确重试。主模型并不需要知道错误原因，而是需要知道：
1. 编辑失败了，文件仍然没变
2. 按照不同的情况处理：
- 修改本身较为复杂：使用 write 直接写入新的文件后，将新文件替换掉原文件
- 修改本身较为简单，但是将多步混杂在一起：分解成多步编辑，每步编辑单一明确
- 模型修改情况不符合预期：使用更加明确的指令描述修改意图