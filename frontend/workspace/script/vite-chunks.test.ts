import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"
import config, { workspaceManualChunks } from "../vite.config"

test("Vite keeps the complete Molstar package in one explicit chunk", () => {
  expect(workspaceManualChunks("/repo/node_modules/molstar/lib/mol-plugin/context.js")).toBe("molstar")
  expect(
    workspaceManualChunks(
      "/repo/node_modules/.bun/molstar@5.10.1/node_modules/molstar/lib/mol-plugin-state/builder.js",
    ),
  ).toBe("molstar")
  expect(workspaceManualChunks("C:\\repo\\node_modules\\molstar\\lib\\mol-model\\structure.js")).toBe("molstar")
  expect(workspaceManualChunks("/repo/node_modules/molstar-adjacent/index.js")).toBeUndefined()

  const output = config.build?.rollupOptions?.output
  expect(Array.isArray(output)).toBe(false)
  if (!output || Array.isArray(output)) throw new Error("Expected one Rollup output configuration")
  expect(output.onlyExplicitManualChunks).toBe(true)
  expect(output.manualChunks).toBe(workspaceManualChunks)
})

test("Vite pre-bundles RDKit before a module worker requests it", () => {
  expect(config.optimizeDeps?.include).toContain("@rdkit/rdkit")
})

function packageName(node: ts.Expression | undefined) {
  return node && ts.isStringLiteral(node) ? node.text : undefined
}

function isMolstar(value: string | undefined) {
  return value === "molstar" || value?.startsWith("molstar/") === true
}

function importHasRuntimeBindings(node: ts.ImportDeclaration) {
  const clause = node.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  if (!bindings) return false
  if (ts.isNamespaceImport(bindings)) return true
  return bindings.elements.some((item) => !item.isTypeOnly)
}

function exportHasRuntimeBindings(node: ts.ExportDeclaration) {
  if (node.isTypeOnly) return false
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true
  return node.exportClause.elements.some((item) => !item.isTypeOnly)
}

test("the app entry keeps Molstar behind a dynamic import boundary", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const seen = new Set<string>(), offenders: string[] = []
  const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, baseUrl: root, paths: { "@/*": ["src/*"] }, allowJs: true }
  const visit = async (path: string) => {
    const { realpathSync } = await import("node:fs")
    path = realpathSync(path)
    if (seen.has(path) || path.includes("/node_modules/") || !/\.[cm]?[jt]sx?$/.test(path)) return
    seen.add(path)
    const source = ts.createSourceFile(path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true)
    for (const statement of source.statements) {
      let spec: string | undefined
      if (ts.isImportDeclaration(statement) && importHasRuntimeBindings(statement)) spec = packageName(statement.moduleSpecifier)
      if (ts.isExportDeclaration(statement) && exportHasRuntimeBindings(statement)) spec = packageName(statement.moduleSpecifier)
      if (!spec) continue
      if (isMolstar(spec)) { offenders.push(path); continue }
      const resolved = ts.resolveModuleName(spec, path, options, ts.sys).resolvedModule?.resolvedFileName
      if (resolved && /\.[cm]?[jt]sx?$/.test(resolved)) await visit(resolved)
    }
  }
  await visit(fileURLToPath(new URL("../src/entry.tsx", import.meta.url)))
  expect(offenders).toEqual([])
})
