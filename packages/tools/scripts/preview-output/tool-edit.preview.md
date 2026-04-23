# Tool Definition: edit
<!-- generated for model: claude-sonnet-4-20250514 -->

## parameters

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File path relative to project root"
    },
    "intent": {
      "type": "string",
      "description": "Edit intent in free-form text: natural language description, code snippets, or a mix of both. Describe what to change and where."
    }
  },
  "required": [
    "path",
    "intent"
  ],
  "additionalProperties": false
}
```

## description

````
Edit a file by describing your modification intent. An editor agent interprets your intent and applies changes precisely.

This tool is deterministic and always succeeds — do not wait for its result. Continue issuing more tool calls in the same response.

## Examples

```
edit({ path: "src/config.ts", intent: "Change TIMEOUT from 5000 to 10000" })
```

```
edit({ path: "src/api.ts", intent: "Add a retry loop (max 3 attempts) around the fetch call in sendRequest" })
```

```
edit({ path: "src/auth.ts", intent: "Replace the validateToken function with:\nfunction validateToken(token: string): boolean {\n  const decoded = jwt.verify(token, SECRET);\n  return !!decoded;\n}" })
```

## Tips

- Describe **what** to change using semantic references (function names, variable names, etc.)
- For small changes, natural language is concise; for rewrites, provide the full new code

````

## Full OpenAI function format

```json
{
  "type": "function",
  "function": {
    "name": "edit",
    "description": "Edit a file by describing your modification intent. An editor agent interprets your intent and applies changes precisely.\n\nThis tool is deterministic and always succeeds — do not wait for its result. Continue issuing more tool calls in the same response.\n\n## Examples\n\n```\nedit({ path: \"src/config.ts\", intent: \"Change TIMEOUT from 5000 to 10000\" })\n```\n\n```\nedit({ path: \"src/api.ts\", intent: \"Add a retry loop (max 3 attempts) around the fetch call in sendRequest\" })\n```\n\n```\nedit({ path: \"src/auth.ts\", intent: \"Replace the validateToken function with:\\nfunction validateToken(token: string): boolean {\\n  const decoded = jwt.verify(token, SECRET);\\n  return !!decoded;\\n}\" })\n```\n\n## Tips\n\n- Describe **what** to change using semantic references (function names, variable names, etc.)\n- For small changes, natural language is concise; for rewrites, provide the full new code\n",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "File path relative to project root"
        },
        "intent": {
          "type": "string",
          "description": "Edit intent in free-form text: natural language description, code snippets, or a mix of both. Describe what to change and where."
        }
      },
      "required": [
        "path",
        "intent"
      ],
      "additionalProperties": false
    }
  }
}
```
