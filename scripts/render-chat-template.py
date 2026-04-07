# /// script
# dependencies = ["jinja2"]
# ///
"""
用 Qwen chat_template.jinja 将请求 JSON 渲染为完整文本流。

用法：
  uv run scripts/render-chat-template.py [--json .temp/code-request.json] [--template .temp/chat_template.jinja] [--out .temp/rendered-prompt.txt]
"""

import json
import sys
import argparse
from pathlib import Path

from jinja2 import BaseLoader, Environment


def main():
    parser = argparse.ArgumentParser(description="Render Qwen chat template")
    parser.add_argument(
        "--json",
        default=".temp/code-request.json",
        help="Request JSON file path",
    )
    parser.add_argument(
        "--template",
        default="scripts/chat_template.jinja",
        help="Jinja template file path",
    )
    parser.add_argument(
        "--out",
        default=".temp/rendered-prompt.txt",
        help="Output rendered text file path",
    )
    args = parser.parse_args()

    # 读取请求 JSON
    json_path = Path(args.json)
    if not json_path.exists():
        print(f"Error: {json_path} not found. Run build-code-request.ts first.", file=sys.stderr)
        sys.exit(1)

    with open(json_path, "r", encoding="utf-8") as f:
        request_data = json.load(f)

    # 读取 Jinja 模板
    template_path = Path(args.template)
    if not template_path.exists():
        print(f"Error: {template_path} not found.", file=sys.stderr)
        sys.exit(1)

    with open(template_path, "r", encoding="utf-8") as f:
        template_source = f.read()

    # Qwen 模板需要的 raise_exception 函数
    def raise_exception(msg):
        raise ValueError(msg)

    # 构建 Jinja 环境
    env = Environment(
        loader=BaseLoader(),
        keep_trailing_newline=True,
        # Qwen 模板使用默认的 {{ }} / {% %} 语法
    )
    env.globals["raise_exception"] = raise_exception

    template = env.from_string(template_source)

    # 渲染：Qwen 模板接收 messages、tools、add_generation_prompt 等参数
    # tools 在 Qwen 模板中期望直接是 function 描述对象列表（不带 type: "function" 包装）
    # 模板中 tool | tojson 直接序列化每个 tool 对象
    tools_for_template = request_data.get("tools")
    if tools_for_template:
        # Qwen 模板期望 tools 是 [{type:"function", function:{...}}] 形式
        # 直接传入即可，模板会 tojson 序列化
        pass

    rendered = template.render(
        messages=request_data["messages"],
        tools=tools_for_template,
        add_generation_prompt=request_data.get("add_generation_prompt", True),
        enable_thinking=request_data.get("enable_thinking", True),
        add_vision_id=request_data.get("add_vision_id", False),
    )

    # 写入输出文件
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(rendered)

    # 统计信息
    char_count = len(rendered)
    line_count = rendered.count("\n") + 1
    # 粗略估算 token 数（中英混合约 2-3 字符/token）
    approx_tokens = char_count // 3

    print(f"Rendered prompt written to: {out_path}")
    print(f"  Characters: {char_count:,}")
    print(f"  Lines: {line_count:,}")
    print(f"  Approx tokens: ~{approx_tokens:,}")

    # 打印结构概览
    print(f"\nStructure overview:")
    # 找到所有 <|im_start|> 标记并打印角色
    lines = rendered.split("\n")
    for i, line in enumerate(lines):
        if "<|im_start|>" in line:
            role = line.replace("<|im_start|>", "").strip()
            # 找到对应的 <|im_end|> 计算该段长度
            end_line = i
            for j in range(i + 1, len(lines)):
                if "<|im_end|>" in lines[j]:
                    end_line = j
                    break
            segment_chars = sum(len(lines[k]) for k in range(i, min(end_line + 1, len(lines))))
            print(f"  [{role}] line {i+1}-{end_line+1} ({segment_chars:,} chars)")


if __name__ == "__main__":
    main()
