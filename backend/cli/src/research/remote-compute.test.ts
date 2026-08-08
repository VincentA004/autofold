import { describe, expect, test } from "bun:test"
import { ResearchRemoteCompute } from "./remote-compute"

describe("research remote compute", () => {
  test("uses local compute by default", () => {
    expect(ResearchRemoteCompute.profile("run_abc", true, {})).toEqual({ kind: "local" })
  })

  test("builds a bounded SSH profile", () => {
    const profile = ResearchRemoteCompute.profile("run_abc", true, {
      AUTOFOLD_RESEARCH_COMPUTE: "ssh:workstation_4090",
      AUTOFOLD_RESEARCH_REMOTE_ROOT: "/home/vincent/.autofold",
      AUTOFOLD_RESEARCH_REMOTE_PYTHON: "/home/vincent/.venvs/autofold/bin/python",
      AUTOFOLD_RESEARCH_REMOTE_PROTO_ROOT: "/home/vincent/proto-language",
    })
    expect(profile).toEqual({
      kind: "ssh",
      host: {
        id: "workstation_4090",
        label: "workstation_4090",
        host: "workstation_4090",
        scheduler: "none",
        workdir: "/home/vincent/.autofold/runs/run_abc",
      },
      remoteRun: "/home/vincent/.autofold/runs/run_abc",
      python: "/home/vincent/.venvs/autofold/bin/python",
      protoRoot: "/home/vincent/proto-language",
    })
  })

  test("rejects shell-shaped SSH configuration", () => {
    expect(() =>
      ResearchRemoteCompute.profile("run_abc", false, {
        AUTOFOLD_RESEARCH_COMPUTE: "ssh:box;touch",
        AUTOFOLD_RESEARCH_REMOTE_ROOT: "/tmp/autofold",
        AUTOFOLD_RESEARCH_REMOTE_PYTHON: "/usr/bin/python3",
      }),
    ).toThrow("unsupported characters")
    expect(() =>
      ResearchRemoteCompute.profile("run_abc", false, {
        AUTOFOLD_RESEARCH_COMPUTE: "ssh:box",
        AUTOFOLD_RESEARCH_REMOTE_ROOT: "/tmp/autofold with spaces",
        AUTOFOLD_RESEARCH_REMOTE_PYTHON: "/usr/bin/python3",
      }),
    ).toThrow("safe absolute POSIX path")
    expect(() =>
      ResearchRemoteCompute.profile("run_abc", false, {
        AUTOFOLD_RESEARCH_COMPUTE: "ssh:box",
        AUTOFOLD_RESEARCH_REMOTE_ROOT: "/tmp/autofold/..",
        AUTOFOLD_RESEARCH_REMOTE_PYTHON: "/usr/bin/python3",
      }),
    ).toThrow("safe absolute POSIX path")
  })

  test("constructs a remote worker launch without local paths", () => {
    const profile = ResearchRemoteCompute.profile("run_abc", true, {
      AUTOFOLD_RESEARCH_COMPUTE: "ssh:workstation_4090",
      AUTOFOLD_RESEARCH_REMOTE_ROOT: "/srv/autofold",
      AUTOFOLD_RESEARCH_REMOTE_PYTHON: "/srv/venv/bin/python",
      AUTOFOLD_RESEARCH_REMOTE_PROTO_ROOT: "/srv/proto",
    })
    const launch = ResearchRemoteCompute.command(profile, {
      python: "/local/python",
      bundle: "/local/run/bundle.json",
      output: "/local/run/output",
      evaluator: "/local/worker/autofold_worker/peptide_panel_v1.py",
      evidence: "/local/worker/autofold_worker/evidence_boltz2_v1.py",
    })
    expect(launch.target).toEqual({ kind: "ssh", host_id: "workstation_4090" })
    expect(launch.cwd).toBe("/srv/autofold/runs/run_abc")
    expect(launch.command).toContain("AUTOFOLD_PROTO_ROOT='/srv/proto'")
    expect(launch.command).toContain("'/srv/venv/bin/python'")
    expect(launch.command).not.toContain("/local/")
  })
})
