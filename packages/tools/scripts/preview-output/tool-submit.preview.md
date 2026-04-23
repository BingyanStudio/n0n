# Tool Definition: submit
<!-- generated for model: claude-sonnet-4-20250514 -->

## parameters

```json
{
  "type": "object"
}
```

## description

````
Submit your final result. Fill in the fields directly as parameters — they must conform to this schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "const": "completed"
        },
        "summary": {
          "type": "string",
          "description": "完成摘要：做了什么"
        },
        "next_step": {
          "description": "可选的后续步骤建议，坦诚说明可能存在的未完成的、做的不够好的部分",
          "type": "string"
        }
      },
      "required": [
        "type",
        "summary"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "const": "ask_user"
        },
        "question": {
          "type": "string",
          "description": "向用户提出的具体问题"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "choice": {
                "type": "string",
                "description": "选项文本"
              },
              "affect": {
                "type": "string",
                "description": "选择此项后的影响说明"
              }
            },
            "required": [
              "choice",
              "affect"
            ],
            "additionalProperties": false
          },
          "description": "2-4 个选项供用户选择"
        }
      },
      "required": [
        "type",
        "question",
        "options"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "const": "request_assist"
        },
        "content": {
          "type": "string",
          "description": "需要用户协助的具体内容"
        },
        "checklist": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": {
                "type": "string",
                "description": "检查项描述"
              },
              "detail": {
                "description": "补充说明或操作指引",
                "type": "string"
              }
            },
            "required": [
              "label"
            ],
            "additionalProperties": false
          },
          "description": "问卷/检查列表，便于用户逐项执行并反馈结果"
        }
      },
      "required": [
        "type",
        "content",
        "checklist"
      ],
      "additionalProperties": false
    }
  ]
}
```

Validation is enforced — non-conforming submissions will be rejected.
````

## Full OpenAI function format

```json
{
  "type": "function",
  "function": {
    "name": "submit",
    "description": "Submit your final result. Fill in the fields directly as parameters — they must conform to this schema:\n\n```json\n{\n  \"$schema\": \"https://json-schema.org/draft/2020-12/schema\",\n  \"oneOf\": [\n    {\n      \"type\": \"object\",\n      \"properties\": {\n        \"type\": {\n          \"type\": \"string\",\n          \"const\": \"completed\"\n        },\n        \"summary\": {\n          \"type\": \"string\",\n          \"description\": \"完成摘要：做了什么\"\n        },\n        \"next_step\": {\n          \"description\": \"可选的后续步骤建议，坦诚说明可能存在的未完成的、做的不够好的部分\",\n          \"type\": \"string\"\n        }\n      },\n      \"required\": [\n        \"type\",\n        \"summary\"\n      ],\n      \"additionalProperties\": false\n    },\n    {\n      \"type\": \"object\",\n      \"properties\": {\n        \"type\": {\n          \"type\": \"string\",\n          \"const\": \"ask_user\"\n        },\n        \"question\": {\n          \"type\": \"string\",\n          \"description\": \"向用户提出的具体问题\"\n        },\n        \"options\": {\n          \"type\": \"array\",\n          \"items\": {\n            \"type\": \"object\",\n            \"properties\": {\n              \"choice\": {\n                \"type\": \"string\",\n                \"description\": \"选项文本\"\n              },\n              \"affect\": {\n                \"type\": \"string\",\n                \"description\": \"选择此项后的影响说明\"\n              }\n            },\n            \"required\": [\n              \"choice\",\n              \"affect\"\n            ],\n            \"additionalProperties\": false\n          },\n          \"description\": \"2-4 个选项供用户选择\"\n        }\n      },\n      \"required\": [\n        \"type\",\n        \"question\",\n        \"options\"\n      ],\n      \"additionalProperties\": false\n    },\n    {\n      \"type\": \"object\",\n      \"properties\": {\n        \"type\": {\n          \"type\": \"string\",\n          \"const\": \"request_assist\"\n        },\n        \"content\": {\n          \"type\": \"string\",\n          \"description\": \"需要用户协助的具体内容\"\n        },\n        \"checklist\": {\n          \"type\": \"array\",\n          \"items\": {\n            \"type\": \"object\",\n            \"properties\": {\n              \"label\": {\n                \"type\": \"string\",\n                \"description\": \"检查项描述\"\n              },\n              \"detail\": {\n                \"description\": \"补充说明或操作指引\",\n                \"type\": \"string\"\n              }\n            },\n            \"required\": [\n              \"label\"\n            ],\n            \"additionalProperties\": false\n          },\n          \"description\": \"问卷/检查列表，便于用户逐项执行并反馈结果\"\n        }\n      },\n      \"required\": [\n        \"type\",\n        \"content\",\n        \"checklist\"\n      ],\n      \"additionalProperties\": false\n    }\n  ]\n}\n```\n\nValidation is enforced — non-conforming submissions will be rejected.",
    "parameters": {
      "type": "object"
    }
  }
}
```
