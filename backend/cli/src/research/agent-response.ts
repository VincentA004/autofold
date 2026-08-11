export namespace ResearchAgentResponse {
  function message(error: unknown): string {
    if (!error || typeof error !== "object") return String(error)
    if ("message" in error && typeof error.message === "string" && error.message.trim()) return error.message
    if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data) {
      const nested = error.data.message
      if (typeof nested === "string" && nested.trim()) return nested
    }
    return JSON.stringify(error)
  }

  export function assert(response: { info: { role: string; error?: unknown } }, label: string): void {
    if (response.info.role !== "assistant" || !response.info.error) return
    throw new Error(`${label} failed: ${message(response.info.error)}`)
  }
}
