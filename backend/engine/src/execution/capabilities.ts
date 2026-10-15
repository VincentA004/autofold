import fs from "node:fs/promises"
import path from "node:path"

export class HostCapabilitiesUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "HostCapabilitiesUnavailableError" }
}

export interface ProtoRuntimeIdentity {root: string; languageCommit: string; toolsCommit: string}
export interface GeneratorCapabilityRequest {id: string; config?: Record<string, unknown>}
export interface CapabilityRequest {proto?: ProtoRuntimeIdentity; generators?: GeneratorCapabilityRequest[]; signal?: AbortSignal}
export interface HostCapability {
  id: string; available: boolean | null; requirement: string; path?: string
}
export interface HostCapabilities {
  format: "autofold.host-capabilities.v1"; host: string; checkedAt: string
  runtime: HostCapability[]; generators: HostCapability[]
}
export const externalGeneratorIds = ["boltzgen-binder", "pxdesign-binder"] as const
export function assertCapabilities(report: HostCapabilities, selected: readonly string[] = []) {
  const omitted = selected.filter(id => externalGeneratorIds.includes(id as typeof externalGeneratorIds[number]) && !report.generators.some(item => item.id === id && item.available !== null))
  if (omitted.length) throw new HostCapabilitiesUnavailableError("Host capability preflight lacks an authoritative availability check for selected external lanes: " + omitted.join(", "))
  const missing = [...report.runtime, ...report.generators.filter(item => selected.includes(item.id))].filter(item => item.available === false)
  if (missing.length) throw new HostCapabilitiesUnavailableError("Host capability preflight failed before trial admission: " + missing.map(item => `${item.id}: ${item.requirement}${item.path ? ` (${item.path})` : ""}`).join("; "))
}
async function executable(value: string | undefined) {
  if (!value) return false
  const resolved = path.isAbsolute(value) ? value : Bun.which(value)
  return !!resolved && await fs.access(resolved, fs.constants.X_OK).then(() => fs.stat(resolved).then(stat => stat.isFile()), () => false)
}
async function directory(value: string | undefined) {return !!value && await fs.stat(value).then(stat => stat.isDirectory(), () => false)}
async function pinned(root: string, expected: string, packageName:string) {
  const run=async(args:string[])=>{
    const child=Bun.spawn(["git","-C",root,...args],{stdin:"ignore",stdout:"pipe",stderr:"ignore",timeout:20_000})
    const [code,output]=await Promise.all([child.exited,new Response(child.stdout).text()]);return {code,output}
  }
  const head=await run(["rev-parse","HEAD"])
  if(head.code!==0||head.output.trim()!==expected)return false
  const [dirty,untracked]=await Promise.all([run(["diff","--quiet","HEAD","--",packageName]),run(["ls-files","--others","--",packageName])])
  return dirty.code===0&&untracked.code===0&&!untracked.output.split('\n').some(file=>file.endsWith('.py'))
}

/** Path/permission/git checks only: never imports an authored program or a model. */
export async function localCapabilities(python: string, request: CapabilityRequest): Promise<HostCapabilities> {
  request.signal?.throwIfAborted()
  const runtime: HostCapability[] = [{id: "python", available: await executable(python), requirement: "Configure an installed executable Python interpreter", path: python}]
  if (request.proto) {
    for (const [id, root, commit] of [["proto-language", request.proto.root, request.proto.languageCommit], ["proto-tools", path.join(request.proto.root, "proto-tools"), request.proto.toolsCommit]]) {
      runtime.push({id: id!, available: await directory(root) && await pinned(root!, commit!, id==="proto-language"?"proto_language":"proto_tools"), requirement: "Install the configured Proto checkout at its frozen git commit with unchanged executable package bytes", path: root})
    }
  }
  const generators = await Promise.all((request.generators ?? externalGeneratorIds.map((id): GeneratorCapabilityRequest => ({id}))).map(async (item): Promise<HostCapability> => {
    const config = item.config ?? {}
    if (item.id === "boltzgen-binder") {
      const command = typeof config.executable === "string" ? config.executable : process.env.AUTOFOLD_BOLTZGEN_EXECUTABLE ?? "boltzgen"
      const cache = typeof config.cache_dir === "string" ? config.cache_dir : process.env.AUTOFOLD_BOLTZGEN_CACHE
      return {id: item.id, available: await executable(command) && await directory(cache), requirement: "Configure an installed BoltzGen executable and model cache directory", path: command}
    }
    if (item.id === "pxdesign-binder") {
      const command = typeof config.executable === "string" ? config.executable : process.env.AUTOFOLD_PXDESIGN_EXECUTABLE ?? "pxdesign"
      return {id: item.id, available: await executable(command), requirement: "Configure an installed PXDesign executable", path: command}
    }
    return {id: item.id, available: true, requirement: "Native registered generator; model assets are validated separately"}
  }))
  request.signal?.throwIfAborted()
  return {format: "autofold.host-capabilities.v1", host: "local", checkedAt: new Date().toISOString(), runtime, generators}
}
