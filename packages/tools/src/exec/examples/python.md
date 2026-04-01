### `python`: data analysis, scripting
```
import json
data = json.load(open("package.json"))
deps = data.get("dependencies", {})
print(f"Dependencies ({len(deps)}):")
for k, v in sorted(deps.items()): print(f"  {k}: {v}")
```
**Advanced — recursive project analysis in one call:**
```
import os, json
stats = {'files': 0, 'lines': 0, 'by_ext': {}}
for root, dirs, files in os.walk('src'):
    dirs[:] = [d for d in dirs if d not in ('node_modules', '.git', '__pycache__')]
    for f in files:
        ext = os.path.splitext(f)[1]
        stats['files'] += 1
        stats['by_ext'][ext] = stats['by_ext'].get(ext, 0) + 1
        try:
            with open(os.path.join(root, f), encoding='utf-8', errors='replace') as fh:
                stats['lines'] += len(fh.readlines())
        except (OSError, UnicodeDecodeError) as e:
            print(f'Warning: skipping {os.path.join(root, f)}: {e}', flush=True)
print(json.dumps(stats, indent=2))
```
**With libraries — `pip install libcst` then analyze Python AST:**
```
import libcst as cst, os, json
results = []
for root, _, files in os.walk('src'):
    for f in [f for f in files if f.endswith('.py')]:
        path = os.path.join(root, f)
        with open(path, encoding='utf-8') as fh:
            mod = cst.parse_module(fh.read())
        classes = [n.name.value for n in mod.body if isinstance(n, cst.ClassDef)]
        funcs = [n.name.value for n in mod.body if isinstance(n, cst.FunctionDef)]
        if classes or funcs: results.append({'file': path, 'classes': classes, 'functions': funcs})
print(json.dumps(results, indent=2))
```
