@echo off
chcp 65001>nul
setlocal

:: 一键预览 apps/code 场景的完整文本流（渲染 Qwen / GLM / Claude 三个模板）
:: 包含 fewshot 教学对话 + 工具定义 + system prompt 的完整请求
::
:: 用法：
::   scripts\preview-code-prompt.cmd
::   scripts\preview-code-prompt.cmd --user "修复登录 bug"

cd /d "%~dp0\.."

echo ==^> Step 1: Building request JSON (with fewshot)...
bun run scripts/build-code-request.ts %*
if errorlevel 1 goto :fail
echo.

echo ==^> Step 2a: Rendering with Qwen chat template...
uv run scripts/render-chat-template.py --template scripts/chat_template_qwen.jinja --out .temp/rendered-prompt-qwen.md
if errorlevel 1 goto :fail
echo.

echo ==^> Step 2b: Rendering with GLM chat template...
uv run scripts/render-chat-template.py --template scripts/chat_template_glm.jinja --out .temp/rendered-prompt-glm.md
if errorlevel 1 goto :fail
echo.

echo ==^> Step 2c: Rendering with Claude chat template (approximate)...
uv run scripts/render-chat-template.py --template scripts/chat_template_claude.jinja --out .temp/rendered-prompt-claude.md
if errorlevel 1 goto :fail
echo.

echo ==^> Done.
echo   Request JSON:   .temp/code-request.json
echo   Qwen output:    .temp/rendered-prompt-qwen.md
echo   GLM output:     .temp/rendered-prompt-glm.md
echo   Claude output:  .temp/rendered-prompt-claude.md
goto :eof

:fail
echo.
echo ERROR: step failed, see output above.
exit /b 1
