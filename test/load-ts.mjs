import { readFile } from 'node:fs/promises'
import ts from 'typescript'

export function moduleUrl(source, imports = {}) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  })
  const resolved = outputText.replace(/from (['"])([^'"]+)\1/g, (match, quote, path) =>
    path in imports ? `from ${quote}${imports[path]}${quote}` : match)
  return `data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`
}

export async function loadTs(path, imports = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  return import(moduleUrl(source, imports))
}
