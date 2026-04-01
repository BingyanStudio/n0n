- `bun` (TypeScript/JS, recommended): preprocess data, parse JSON, transform files
  ```
  import { readdir } from "node:fs/promises";
  const files = await readdir("./src", { recursive: true });
  const tsFiles = files.filter(f => f.endsWith(".ts"));
  console.log('Found ' + tsFiles.length + ' TS files');
  for (const f of tsFiles.slice(0, 10)) console.log(' - ' + f);
  ```
  **Advanced — one script replaces many shell round-trips:**
  ```
  import { readdir, readFile, stat } from 'node:fs/promises';
  import { join, extname } from 'node:path';
  async function tree(dir: string, prefix = ''): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const lines: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        lines.push(prefix + '📁 ' + e.name + '/');
        lines.push(...await tree(full, prefix + '  '));
      } else {
        const s = await stat(full);
        const lc = extname(e.name).match(/\.(ts|js|py|md)$/) ? (await readFile(full,'utf8')).split('\n').length : null;
        lines.push(prefix + '📄 ' + e.name + ' (' + s.size + 'B' + (lc !== null ? ', '+lc+' lines' : '') + ')');
      }
    }
    return lines;
  }
  console.log((await tree('src')).join('\n'));
  ```
  **With libraries — install then use immediately:**
  `bun add ts-morph` → then in the next exec call:
  ```
  import { Project } from 'ts-morph';
  const p = new Project({ tsConfigFilePath: 'tsconfig.json' });
  for (const sf of p.getSourceFiles()) {
    const fns = sf.getFunctions().map(f => f.getName());
    const cls = sf.getClasses().map(c => c.getName());
    const imps = sf.getImportDeclarations().length;
    if (fns.length || cls.length)
      console.log(sf.getFilePath(), { functions: fns, classes: cls, imports: imps });
  }
  ```
