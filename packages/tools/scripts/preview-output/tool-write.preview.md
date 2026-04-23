# Tool Definition: write
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
    "content": {
      "type": "string",
      "description": "Complete file content to write"
    }
  },
  "required": [
    "path",
    "content"
  ],
  "additionalProperties": false
}
```

## description

````
Create or overwrite a file with the given content. Directories are created automatically. For modifying existing files, use the edit tool instead.

This tool is deterministic and always succeeds — do not wait for its result. Continue issuing more tool calls in the same response.
````

## Full OpenAI function format

```json
{
  "type": "function",
  "function": {
    "name": "write",
    "description": "Create or overwrite a file with the given content. Directories are created automatically. For modifying existing files, use the edit tool instead.\n\nThis tool is deterministic and always succeeds — do not wait for its result. Continue issuing more tool calls in the same response.",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "File path relative to project root"
        },
        "content": {
          "type": "string",
          "description": "Complete file content to write"
        }
      },
      "required": [
        "path",
        "content"
      ],
      "additionalProperties": false
    }
  }
}
```
