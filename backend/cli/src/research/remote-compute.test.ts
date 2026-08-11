import { describe, expect, test } from "bun:test"
import { ResearchRemoteCompute } from "./remote-compute"

describe("research remote compute", () => {
  test("uses local compute by default", () => {
    expect(ResearchRemoteCompute.profile("run_abc", true, {})).toEqual({ kind: "local" })
  })

  test("builds a bounded SSH profile", () => {
    const profile = ResearchRemoteCompute.profile("run_abc", true, {
      AUTOFOLD_RESEARCH_COMPUTE: "ssh:workstation_4090",
      AUTOFOLD_RESEARCH_REMOTE_HOST: "100.88.23.66",
      AUTOFOLD_RESEARCH_REMOTE_ROOT: "/home/vincent/.autofold",
      AUTOFOLD_RESEARCH_REMOTE_PYTHON: "/home/vincent/.venvs/autofold/bin/python",
      AUTOFOLD_RESEARCH_REMOTE_PROTO_ROOT: "/home/vincent/proto-language",
      AUTOFOLD_RESEARCH_REMOTE_PROTO_HOME: "/home/vincent/.proto",
      AUTOFOLD_RESEARCH_REMOTE_BOLTZGEN_EXECUTABLE: "/home/vincent/boltzgen/bin/boltzgen",
      AUTOFOLD_RESEARCH_REMOTE_BOLTZGEN_CACHE: "/home/vincent/boltzgen/cache",
      AUTOFOLD_RESEARCH_REMOTE_PXDESIGN_EXECUTABLE: "/home/vincent/pxdesign/bin/pxdesign",
    })
    expect(profile).toEqual({
      kind: "ssh",
      host: {
        id: "workstation_4090",
        label: "workstation_4090",
        host: "workstation_4090",
        address: "100.88.23.66",
        scheduler: "none",
        workdir: "/home/vincent/.autofold/runs/run_abc",
      },
      remoteRun: "/home/vincent/.autofold/runs/run_abc",
      python: "/home/vincent/.venvs/autofold/bin/python",
      protoRoot: "/home/vincent/proto-language",
      protoHome: "/home/vincent/.proto",
      boltzgenExecutable: "/home/vincent/boltzgen/bin/boltzgen",
      boltzgenCache: "/home/vincent/boltzgen/cache",
      pxdesignExecutable: "/home/vincent/pxdesign/bin/pxdesign",
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
      AUTOFOLD_RESEARCH_REMOTE_HOST: "100.88.23.66",
      AUTOFOLD_RESEARCH_REMOTE_ROOT: "/srv/autofold",
      AUTOFOLD_RESEARCH_REMOTE_PYTHON: "/srv/venv/bin/python",
      AUTOFOLD_RESEARCH_REMOTE_PROTO_ROOT: "/srv/proto",
      AUTOFOLD_RESEARCH_REMOTE_PROTO_HOME: "/srv/proto-home",
      AUTOFOLD_RESEARCH_REMOTE_BOLTZGEN_EXECUTABLE: "/srv/boltzgen/bin/boltzgen",
      AUTOFOLD_RESEARCH_REMOTE_BOLTZGEN_CACHE: "/srv/boltzgen/cache",
      AUTOFOLD_RESEARCH_REMOTE_PXDESIGN_EXECUTABLE: "/srv/pxdesign/bin/pxdesign",
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
    expect(launch.command).toContain("PROTO_HOME='/srv/proto-home'")
    expect(launch.command).toContain("AUTOFOLD_BOLTZGEN_EXECUTABLE='/srv/boltzgen/bin/boltzgen'")
    expect(launch.command).toContain("AUTOFOLD_BOLTZGEN_CACHE='/srv/boltzgen/cache'")
    expect(launch.command).toContain("AUTOFOLD_PXDESIGN_EXECUTABLE='/srv/pxdesign/bin/pxdesign'")
    expect(launch.command).toContain("'/srv/venv/bin/python'")
    expect(launch.command).not.toContain("/local/")
  })

  test("requires gated Protenix v2 weights before a remote launch", () => {
    const bundle = {
      pipeline: {
        stages: [
          {
            models: [
              {
                toolKey: "protenix-prediction",
                config: { model_name: "protenix-v2" },
              },
            ],
          },
        ],
      },
    }
    expect(ResearchRemoteCompute.requiredProtoArtifacts(bundle, "/srv/proto-home")).toEqual([
      "/srv/proto-home/proto_model_cache/protenix/checkpoint/protenix-v2.pt",
    ])
    expect(
      ResearchRemoteCompute.requiredProtoArtifacts(
        { pipeline: { stages: [{ models: [{ toolKey: "protenix-prediction", config: { model_name: "protenix_mini_esm_v0.5.0" } }] }] } },
        "/srv/proto-home",
      ),
    ).toEqual([])
  })
})
