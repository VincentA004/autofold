from __future__ import annotations

import unittest
from types import SimpleNamespace

from autofold_worker.proto_trial import DiagnosticStage, ProtoTrial, TrialContext, load_authored_trial


class ProtoTrialTests(unittest.TestCase):
    def setUp(self) -> None:
        self.bundle = {
            "experimentId": "exp_test",
            "contractHash": "sha256:" + "a" * 64,
            "targetArtifactHash": "sha256:" + "b" * 64,
            "targetArtifactPath": "target.json",
            "targetStructurePath": "target.pdb",
            "modality": "short_peptide",
            "seeds": [7, 11],
            "candidateBudget": 6,
            "submissionSize": 3,
            "intent": "optimize",
        }

    def test_context_exposes_frozen_fields_without_bundle_boilerplate(self) -> None:
        context = TrialContext.from_bundle(self.bundle)
        self.assertEqual(context.candidate_budget, 6)
        self.assertEqual(context.submission_size, 3)
        self.assertEqual(context.seeds, (7, 11))
        self.assertEqual(str(context.target_structure_path), "target.pdb")
        self.assertEqual(context["candidateBudget"], 6)

    def test_loads_one_agent_authored_trial_object(self) -> None:
        program = SimpleNamespace(run=lambda: None)
        diagnostic = DiagnosticStage(
            id="protenix-check",
            tools=("protenix-prediction",),
            configs={"protenix-prediction": {"use_msa": False}},
            maximum_gpu_seconds=300,
        )
        module = SimpleNamespace(build_trial=lambda context: ProtoTrial(
            program=program,
            hypothesis=f"Explore {context.candidate_budget} candidates",
            diagnostics=(diagnostic,),
        ))

        trial = load_authored_trial(module, self.bundle)

        self.assertIs(trial.program, program)
        self.assertEqual(trial.autofold_declaration(), {"intent": "optimize"})
        self.assertEqual(trial.autofold_diagnostic_plan(), [{
            "id": "protenix-check",
            "role": "diagnostic",
            "capability": "structure_prediction",
            "tools": ["protenix-prediction"],
            "configs": {"protenix-prediction": {"use_msa": False}},
            "selection": "all",
            "dependsOn": [],
            "maximumGpuSeconds": 300,
            "optional": True,
        }])

    def test_adapts_legacy_build_program_during_migration(self) -> None:
        program = SimpleNamespace(run=lambda: None)
        module = SimpleNamespace(
            build_program=lambda bundle: program,
            AUTOFOLD_TRIAL={"intent": "calibrate", "calibrationClass": "known_positive"},
            __doc__="Known reference panel",
        )
        trial = load_authored_trial(module, self.bundle)
        self.assertEqual(trial.hypothesis, "Known reference panel")
        self.assertEqual(trial.autofold_declaration(), {
            "intent": "calibrate",
            "calibrationClass": "known_positive",
        })


if __name__ == "__main__":
    unittest.main()
