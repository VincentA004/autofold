import path from "node:path"
const ansiEscape = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const progressFrame = /^[\u2800-\u28ff]?\s*Running\s+\S+.*\[\d{2}:\d{2}(?::\d{2})?\]\s*$/

export function compactRunError(value: unknown, maximum = 4096): string {
  const raw = (value instanceof Error ? value.message : String(value)).replace(ansiEscape, "")
  const lines: string[] = []
  for (const fragment of raw.split(/[\r\n]+/)) {
    const line = fragment.trimEnd()
    if (!line.trim() || progressFrame.test(line.trim())) continue
    if (lines.at(-1) !== line) lines.push(line)
  }
  const compact = lines.join("\n").trim() || "Research execution failed without diagnostic output"
  if (compact.length <= maximum) return compact
  const marker = "\n… execution log compacted …\n"
  const head = Math.min(1024, Math.floor((maximum - marker.length) / 3))
  return compact.slice(0, head) + marker + compact.slice(-(maximum - marker.length - head))
}

export async function stageFailureDetail(
  output: string,
  stage: { stage?: string; status?: string; error?: string } | undefined,
  fallback?: string,
): Promise<string> {
  const headline = stage?.stage
    ? `Remote worker ended during ${stage.stage} (${stage.status ?? "unknown"})${stage.error ? `: ${stage.error}` : ""}`
    : undefined
  const stageName = stage?.stage?.match(/^(generation|evidence)$/)?.[1]
  if (!stageName) return compactRunError(headline || fallback || "Remote worker failed without stage diagnostics")

  const stageRoot = path.join(output, ".stages")
  const [structured, stack] = await Promise.all([
    Bun.file(path.join(stageRoot, `${stageName}-result.error.json`))
      .json()
      .catch(() => undefined) as Promise<{ errorType?: string; error?: string } | undefined>,
    Bun.file(path.join(stageRoot, `${stageName}-stack.log`))
      .text()
      .catch(() => ""),
  ])
  const structuredDetail = structured?.error
    ? `${structured.errorType ? `${structured.errorType}: ` : ""}${structured.error}`
    : undefined
  // The periodic faulthandler file can contain several snapshots. Its tail is
  // the most recent blocked call and therefore the useful part for the next
  // scientist iteration; compactRunError applies the final persisted bound.
  const stackTail = stack.trim() ? stack.slice(-16_384) : undefined
  return compactRunError(
    [headline, structuredDetail, stackTail, !headline && !structuredDetail && !stackTail ? fallback : undefined]
      .filter(Boolean)
      .join("\n"),
  )
}

/** A missing trusted host integration cannot be repaired by rewriting scientific code. */
export class ExecutionPreflightUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "ExecutionPreflightUnavailableError" }
}
