import { describe, expect, test } from "bun:test"
import { ComputeJobs } from "./jobs"

describe("SSH compute job bounds", () => {
  test("wraps scheduler-free remote jobs with a wall timeout and cancellable process-group marker", () => {
    const result = ComputeJobs.command(
      {
        id: "job-one",
        name: "Bounded remote run",
        command: "python worker.py",
        cwd: "/srv/autofold/run-one",
        resources: { time_minutes: 12, gpus: 1 },
      },
      {
        id: "gpu",
        label: "GPU",
        host: "gpu.example",
        scheduler: "none",
        workdir: "/srv/autofold",
      },
    )
    const remote = result.argv.at(-1)!
    expect(remote).toContain("timeout --signal=TERM --kill-after=30s 720s")
    expect(remote).toContain("setsid bash -lc")
    expect(remote).toContain(".openscience/jobs/job-one.pid")
    expect(remote).toContain('wait \"$child\"')
  })

  test("cancels nested model sessions before the remote worker group", () => {
    const action = ComputeJobs.cancellationAction("job-one")
    expect(action).toContain('/proc/$1/task/$1/children')
    expect(action).toContain('nested=$(descendants "$child")')
    expect(action.indexOf('kill -TERM -- -"$pid"')).toBeLessThan(action.indexOf('kill -TERM -- -"$child"'))
    expect(action).toContain('kill -KILL -- -"$pid"')
  })

  test("reconnects to an environment-profile SSH alias when saved hosts are absent", () => {
    const job = ComputeJobs.Job.parse({
      id: "job-one",
      name: "Remote trial",
      command: "python worker.py",
      cwd: "/srv/autofold/run-one",
      target: { kind: "ssh", host_id: "workstation_4090" },
      target_label: "workstation_4090",
      scheduler: "none",
      status: "running",
      created_at: "2026-08-29T00:00:00.000Z",
    })
    expect(ComputeJobs.cancellationHost(job)).toEqual({
      id: "workstation_4090",
      label: "workstation_4090",
      host: "workstation_4090",
      scheduler: "none",
      workdir: "/srv/autofold/run-one",
    })
  })
})
