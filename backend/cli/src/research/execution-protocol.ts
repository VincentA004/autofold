import z from "zod"

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export namespace ExecutionProtocol {
  const TrialBundleFields = {
    runId: z.string().startsWith("run_"),
    trialId: z.string().startsWith("trl_"),
    contractHash: Digest,
    designAdapter: z.enum(["mock", "proto"]),
    programPath: z.string().trim().min(1),
    programHash: Digest,
    modality: z.enum(["linear_minibinder", "short_peptide", "cyclic_peptide", "modified_peptide"]),
    evaluator: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      sourceHash: Digest,
      direction: z.enum(["minimize", "maximize"]),
    }),
    proto: z
      .object({
        root: z.string().trim().min(1),
        languageCommit: z.string().regex(/^[a-f0-9]{40}$/),
        toolsCommit: z.string().regex(/^[a-f0-9]{40}$/),
      })
      .optional(),
    seeds: z.array(z.number().int()).min(1),
    candidateBudget: z.number().int().positive(),
    submissionSize: z.number().int().positive(),
  }
  export const TrialBundleV1 = z.object({ format: z.literal("autofold.trial-bundle.v1"), ...TrialBundleFields })
  export const TrialBundleV2 = z.object({
    format: z.literal("autofold.trial-bundle.v2"),
    ...TrialBundleFields,
    targetArtifactHash: Digest,
    targetArtifactPath: z.string().trim().min(1).optional(),
  })
  export const TrialBundleV3 = z
    .object({
      format: z.literal("autofold.trial-bundle.v3"),
      ...TrialBundleFields,
      targetArtifactHash: Digest,
      targetArtifactPath: z.string().trim().min(1),
      targetStructurePath: z.string().trim().min(1).optional(),
      evidenceAdapter: z.object({
        id: z.string().trim().min(1),
        version: z.string().trim().min(1),
        sourceHash: Digest,
      }),
    })
    .refine((bundle) => bundle.designAdapter === "proto" && bundle.proto !== undefined, {
      message: "Trusted scientific bundles require the pinned Proto runtime",
      path: ["proto"],
    })
  export const TrialBundle = z.union([TrialBundleV1, TrialBundleV2, TrialBundleV3])
  export type TrialBundle = z.infer<typeof TrialBundle>

  export const Candidate = z.object({
    id: z.string().min(1),
    sequence: z.string().regex(/^[ACDEFGHIKLMNPQRSTVWY]+$/),
    seed: z.number().int(),
  })
  export type Candidate = z.infer<typeof Candidate>

  export const CandidateSetV1 = z.object({
    format: z.literal("autofold.candidate-set.v1"),
    runId: z.string().startsWith("run_"),
    trialId: z.string().startsWith("trl_"),
    candidates: z.array(Candidate),
  })

  const UnitMetric = z.number().finite().min(0).max(1)
  export const PeptideCandidateArtifact = Candidate.extend({
    format: z.literal("autofold.peptide-candidate.v1"),
    modality: z.enum(["linear_minibinder", "short_peptide", "cyclic_peptide", "modified_peptide"]),
    generation: z.object({
      model: z.string().trim().min(1),
      version: z.string().trim().min(1),
      artifactHash: Digest,
      parametersHash: Digest,
    }),
    evidence: z.object({
      interfaceConfidence: UnitMetric,
      foldConfidence: UnitMetric,
      predictorAgreement: UnitMetric,
      solubility: UnitMetric,
      aggregationRisk: UnitMetric,
      synthesisRisk: UnitMetric,
      predictors: z
        .array(
          z.object({
            model: z.string().trim().min(1),
            version: z.string().trim().min(1),
            artifactHash: Digest,
          }),
        )
        .min(1),
    }),
  })
  export type PeptideCandidateArtifact = z.infer<typeof PeptideCandidateArtifact>

  export const CandidateSetV2 = z
    .object({
      format: z.literal("autofold.candidate-set.v2"),
      runId: z.string().startsWith("run_"),
      trialId: z.string().startsWith("trl_"),
      targetArtifactHash: Digest,
      candidates: z.array(PeptideCandidateArtifact),
    })
    .superRefine((candidateSet, context) => {
      const ids = new Set(candidateSet.candidates.map((candidate) => candidate.id))
      if (ids.size !== candidateSet.candidates.length) {
        context.addIssue({ code: "custom", path: ["candidates"], message: "Candidate IDs must be unique" })
      }
    })

  export const CandidateSet = z.union([CandidateSetV1, CandidateSetV2])
  export type CandidateSet = z.infer<typeof CandidateSet>

  export const ModelRunArtifact = z.object({
    format: z.literal("autofold.model-run.v1"),
    candidateId: z.string().trim().min(1),
    targetArtifactHash: Digest,
    peptideSequenceHash: Digest,
    model: z.object({
      id: z.string().trim().min(1),
      version: z.string().trim().min(1),
      adapterSourceHash: Digest,
      protoToolsCommit: z.string().regex(/^[a-f0-9]{40}$/),
    }),
    parametersHash: Digest,
    seed: z.number().int(),
    outputs: z.object({
      structureHash: Digest,
      metricsHash: Digest,
    }),
    metrics: z.record(z.string(), z.unknown()),
  })
  export type ModelRunArtifact = z.infer<typeof ModelRunArtifact>

  export const ModelRunIndex = z.object({
    format: z.literal("autofold.model-run-index.v1"),
    runId: z.string().startsWith("run_"),
    entries: z.array(
      z.object({
        candidateId: z.string().trim().min(1),
        seed: z.number().int(),
        artifactPath: z.string().trim().min(1),
        artifactHash: Digest,
        structurePath: z.string().trim().min(1),
        structureHash: Digest,
        metricsPath: z.string().trim().min(1),
        metricsHash: Digest,
      }),
    ),
  })
  export type ModelRunIndex = z.infer<typeof ModelRunIndex>

  export const EvaluationResult = z.object({
    format: z.literal("autofold.evaluation-result.v1"),
    runId: z.string().startsWith("run_"),
    trialId: z.string().startsWith("trl_"),
    contractHash: Digest,
    evaluatorHash: Digest,
    evidenceAdapterHash: Digest.optional(),
    designAdapter: z.enum(["mock", "proto"]),
    programHash: Digest,
    valid: z.boolean(),
    score: z.number().finite().nullable(),
    diagnostics: z.record(z.string(), z.number().finite()),
  })
  export type EvaluationResult = z.infer<typeof EvaluationResult>

  export const RunManifest = z.object({
    format: z.literal("autofold.run-manifest.v1"),
    runId: z.string().startsWith("run_"),
    trialId: z.string().startsWith("trl_"),
    workerVersion: z.string().min(1),
    pythonVersion: z.string().min(1),
    evaluatorHash: Digest,
    evidenceAdapterHash: Digest.optional(),
    designAdapter: z.enum(["mock", "proto"]),
    programHash: Digest,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    files: z.record(z.string(), Digest),
  })
  export type RunManifest = z.infer<typeof RunManifest>
}
