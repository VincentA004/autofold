from __future__ import annotations

import unittest
import base64
import hashlib
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

    def test_preserves_prospective_decision_metadata_without_changing_legacy_declarations(self) -> None:
        program = SimpleNamespace(run=lambda: None)
        plan = {"question": "Which uncertainty matters?", "selectedAlternativeId": "replicate"}
        trial = ProtoTrial(program=program, hypothesis="Test uncertainty", decision_plan=plan)
        self.assertEqual(trial.autofold_declaration()["decisionPlan"], plan)
        legacy = ProtoTrial(program=program, hypothesis="Legacy")
        self.assertNotIn("decisionPlan", legacy.autofold_declaration())

    def test_context_exposes_frozen_fields_without_bundle_boilerplate(self) -> None:
        context = TrialContext.from_bundle(self.bundle)
        self.assertEqual(context.candidate_budget, 6)
        self.assertEqual(context.submission_size, 3)
        self.assertEqual(context.seeds, (7, 11))
        self.assertEqual(context.generation_seed, 7)
        self.assertNotIn("generationSeed", context._bundle)
        self.assertEqual(str(context.target_structure_path), "target.pdb")
        self.assertEqual(context["candidateBudget"], 6)

    def test_generation_seed_keeps_the_legacy_constructor_shape(self) -> None:
        context = TrialContext(
            "exp_test",
            "sha256:" + "a" * 64,
            "sha256:" + "b" * 64,
            None,
            None,
            "short_peptide",
            (13,),
            6,
            3,
            "optimize",
            {"seeds": [13]},
        )
        self.assertEqual(context.generation_seed, 13)

    def test_host_asset_preserves_exact_bytes_and_rejects_unknown_changed_or_ambiguous_resources(self) -> None:
        data = b"ATOM 1  trailing spaces  \nEND\n"
        asset = {"id": "backbone", "contentHash": "sha256:" + hashlib.sha256(data).hexdigest(),
                 "contentBase64": base64.b64encode(data).decode("ascii"), "nativeBindings": ["/projection/0"]}
        bundle = {**self.bundle, "freshNative": True, "frozenAssets": [asset]}
        context = TrialContext.from_bundle(bundle)
        asset["contentBase64"] = base64.b64encode(b"changed").decode("ascii")
        self.assertEqual(context.read_asset("backbone"), data)
        with self.assertRaisesRegex(ValueError, "absent or ambiguous"):
            context.read_asset("unknown")
        with self.assertRaisesRegex(ValueError, "bytes changed"):
            TrialContext.from_bundle(bundle).read_asset("backbone")
        with self.assertRaisesRegex(ValueError, "absent or ambiguous"):
            TrialContext.from_bundle({**bundle, "frozenAssets": [asset, asset]}).read_asset("backbone")
        with self.assertRaisesRegex(ValueError, "absent or ambiguous"):
            TrialContext.from_bundle(self.bundle).read_asset("backbone")

    def test_historical_evaluator_seeds_keep_their_original_unbounded_fallback(self) -> None:
        for legacy_seed in (-7, 0x1_0000_0000):
            with self.subTest(legacy_seed=legacy_seed):
                context = TrialContext.from_bundle({**self.bundle, "seeds": [legacy_seed]})
                self.assertEqual(context.generation_seed, legacy_seed)

    def test_generation_seed_is_independent_and_uint32_validated(self) -> None:
        context = TrialContext.from_bundle({**self.bundle, "generationSeed": 123456})
        self.assertEqual(context.seeds, (7, 11))
        self.assertEqual(context.generation_seed, 123456)
        with self.assertRaisesRegex(ValueError, "unsigned 32-bit"):
            TrialContext.from_bundle({**self.bundle, "generationSeed": True})
        with self.assertRaisesRegex(ValueError, "unsigned 32-bit"):
            TrialContext.from_bundle({**self.bundle, "generationSeed": 0x1_0000_0000})
        with self.assertRaisesRegex(ValueError, "unsigned 32-bit"):
            TrialContext.from_bundle({**self.bundle, "generationSeed": -1})

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
