import { $ } from "bun"

// Live resource usage for kernel processes. Sampling goes through ps so it
// works without native dependencies; platforms or processes that cannot
// report a value simply omit the field — the UI shows "Unavailable", never 0.
export namespace KernelMetrics {
  export interface Sample {
    cpu_percent?: number
    memory_bytes?: number
  }

  export async function sample(pid: number): Promise<Sample> {
    if (process.platform !== "darwin" && process.platform !== "linux") return {}
    const output = await $`ps -o %cpu=,rss= -p ${pid}`
      .quiet()
      .text()
      .catch(() => "")
    const [cpu, rss] = output.trim().split(/\s+/)
    const usage = Number.parseFloat(cpu ?? "")
    const resident = Number.parseInt(rss ?? "", 10)
    return {
      ...(Number.isFinite(usage) ? { cpu_percent: usage } : {}),
      ...(Number.isFinite(resident) ? { memory_bytes: resident * 1024 } : {}),
    }
  }
}
