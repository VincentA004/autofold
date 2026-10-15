"""Fresh native authority regressions against the installed CPU Proto runtime."""
from __future__ import annotations
from contextlib import nullcontext
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from autofold_worker.protocol import ProtocolError, validate_native_execution

ROOT = Path(__file__).resolve().parents[3]
PROTO = Path(os.environ.get("AUTOFOLD_TEST_PROTO_ROOT", ROOT / ".autofold/cohesive-engine-refactor-20261012/upstream-proto/v4/source"))


class FreshNativeExecutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from proto_language.core import Program
        except ModuleNotFoundError:
            raise unittest.SkipTest("Optional pinned CPU Proto runtime unavailable")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="autofold-native-cpu-")
        self.output = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def bundle(self, path=None):
        from autofold_worker.cli import _worker_tree_hash
        path = path or ROOT / "backend/worker/examples/native_search_trial.py"
        commit = lambda p: subprocess.check_output(["git","-C",str(p),"rev-parse","HEAD"],text=True).strip()
        return {"format":"autofold.trial-bundle.v2", "designAdapter":"proto", "runId":"run_native_cpu", "trialId":"trl_native_cpu",
            "programPath":str(path), "programHash":"sha256:"+hashlib.sha256(path.read_bytes()).hexdigest(),
            "proto":{"root":str(PROTO), "languageCommit":commit(PROTO), "toolsCommit":commit(PROTO/"proto-tools")},
            "worker":{"format":"autofold.worker-tree.v1", "sourceHash":_worker_tree_hash(ROOT/"backend/worker")},
            "seeds":[7], "candidateBudget":1, "submissionSize":1, "intent":"optimize", "modality":"short_peptide",
            "evaluator":{"id":"fixture","version":"1"}, "freshNative":True}

    def admit(self, bundle, trial=None):
        from autofold_worker.adapters.proto import _load_program
        from autofold_worker.proto_trial import load_authored_trial
        from autofold_worker.native_search import describe_native
        from autofold_worker.program_inspection import pin_native_entrypoints, describe_fixed
        pin_native_entrypoints()
        from autofold_worker.native_search import NativeSearchObserver, NativeSearch, NativeOutput
        from types import SimpleNamespace
        with NativeSearchObserver(SimpleNamespace(optimizers=[]),NativeSearch(1,1,1,1,30,(NativeOutput("construction"),)),self.output/"admission",forbid_work=True,forbid_run=True):
            trial = trial or load_authored_trial(_load_program(Path(bundle["programPath"])),bundle)
            fixed = trial.fixed_control is not None
            descriptor = describe_fixed(trial.program, trial.fixed_control,bundle) if fixed else describe_native(trial.program,trial.search,bundle)
        budget = trial.fixed_control.plan() if fixed else {"maximumWallSeconds":trial.search.maximum_wall_seconds,"outputs":trial.search.plan()["outputs"]}
        bundle["nativeExecution"] = {"protocol":"native_fixed_control_v1" if fixed else "native_search_v1", "descriptor":descriptor,
            "outputs":budget["outputs"], "observation":"scoped_native_lifecycle_v1", "resources":{"maximumSearchWallSeconds":budget["maximumWallSeconds"],
            "maximumWorkerWallSeconds":budget["maximumWallSeconds"]+1,"reservedEvaluationWallSeconds":0,"maximumComputeReservationSeconds":0,"reservedSearchComputeSeconds":0,"reservedEvaluationComputeSeconds":0,"invocationReservations":[]}}
        bundle.pop("freshNative")
        return bundle

    def fixed_path(self, callback="", wall=5):
        path=self.output/"fixed.py"
        path.write_text('''from contextlib import nullcontext
from proto_language.core import Program, Construct, Segment, Constraint
from proto_language.constraint import protein_length_constraint
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from autofold_worker.proto_trial import ProtoTrial, NativeFixedControl, NativeOutput
def build_trial(ctx):
    segment=Segment(sequence="ACDE",sequence_type="protein",label="binder")
    construct=Construct([segment],label="control")
    optimizer=RejectionSamplingOptimizer([construct],[],[Constraint([segment],protein_length_constraint,{"min_length":4,"max_length":4})],config=RejectionSamplingOptimizerConfig(proposal_source="existing_results",num_samples=1,num_results=1,proposal_batch_size=1))
'''+callback+f'''    return ProtoTrial(Program([optimizer],1,compute=nullcontext()),"Frozen control remains the admitted panel",intent="negative_control",fixed_control=NativeFixedControl({wall},(NativeOutput("control"),)))
''')
        return path

    def test_cpu_search_without_pipeline_preserves_native_parameters_and_captures_all_stages(self):
        from autofold_worker.adapters.proto import ProtoDesignAdapter
        bundle=self.admit(self.bundle())
        before=json.dumps(bundle["nativeExecution"]["descriptor"],sort_keys=True)
        result=ProtoDesignAdapter().generate(bundle,self.output/"result")
        receipt=json.loads((self.output/"result/native-search/receipt.json").read_text())
        self.assertEqual(len(result["candidates"]),1)
        self.assertEqual(json.dumps(receipt["admission"],sort_keys=True),before)
        self.assertGreater(receipt["counts"]["proposals"],1)
        self.assertTrue(all(stage["history"] for stage in receipt["lanes"][0]["stages"]))
        self.assertNotIn("pipeline",bundle)

    def test_fixed_control_without_pipeline_has_exact_outputs_and_zero_scientific_requests(self):
        from autofold_worker.adapters.proto import ProtoDesignAdapter
        bundle=self.bundle(self.fixed_path());bundle["intent"]="negative_control";self.admit(bundle)
        result=ProtoDesignAdapter().generate(bundle,self.output/"result")
        self.assertEqual([c["sequence"] for c in result["candidates"]],["ACDE"])
        receipt=json.loads((self.output/"result/native-search/receipt.json").read_text())
        self.assertEqual(receipt["counts"],{"proposals":0,"samplingCalls":0,"toolCalls":0})
        self.assertEqual(receipt["admission"],bundle["nativeExecution"]["descriptor"]["nativeProjection"])

    def test_fixed_pool_is_independent_of_final_top_n_and_reserves_actual_model_calls(self):
        from autofold_worker.adapters.proto import ProtoDesignAdapter
        path=self.fixed_path()
        source=path.read_text().replace('Construct([segment],label="control")','Construct([segment],label="control")\n    from proto_language.core import Sequence\n    segment.result_sequences=[Sequence("ACDE","protein"),Sequence("CDEFG","protein")]')
        source=source.replace('num_samples=1,num_results=1,proposal_batch_size=1','num_samples=2,num_results=2,proposal_batch_size=2').replace('Program([optimizer],1,','Program([optimizer],2,')
        path.write_text(source)
        bundle=self.bundle(path);bundle.update(intent="negative_control",candidateBudget=2);self.admit(bundle)
        self.assertEqual(bundle["nativeExecution"]["descriptor"]["fixedSequences"],["ACDE","CDEFG"])
        result=ProtoDesignAdapter().generate(bundle,self.output/"pool")
        self.assertEqual([c["sequence"] for c in result["candidates"]],["ACDE","CDEFG"])
        self.assertEqual(bundle["submissionSize"],1)
        bundle["pipeline"]={"executionBackend":"native_tool_sequence_v1","stages":[{"id":"locked","models":[{"id":"one"},{"id":"two"}],"budget":{"maximumGpuSeconds":3}}]}
        resources=bundle["nativeExecution"]["resources"]
        resources.update(maximumWorkerWallSeconds=20,reservedEvaluationWallSeconds=12,invocationReservations=[{"stageId":"locked","maximumCandidates":2,"seedCount":1,"modelCount":2,"maximumRequests":4,"perRequestTimeoutSeconds":3,"reservedWallSeconds":12}])
        validate_native_execution(bundle)
        resources["invocationReservations"][0]["maximumRequests"]=2
        with self.assertRaisesRegex(ProtocolError,"actual candidate/model/seed"):
            validate_native_execution(bundle)

    def test_fixed_selectors_exclude_unassigned_context_but_freeze_the_whole_native_graph(self):
        from autofold_worker.adapters.proto import ProtoDesignAdapter
        path=self.fixed_path()
        source=path.read_text().replace('optimizer=RejectionSamplingOptimizer([construct],', 'context_segment=Segment(sequence="CCCC",sequence_type="protein",label="context")\n    context=Construct([context_segment],label="unselected")\n    optimizer=RejectionSamplingOptimizer([construct,context],')
        path.write_text(source)
        bundle=self.bundle(path);bundle["intent"]="negative_control";self.admit(bundle)
        descriptor=bundle["nativeExecution"]["descriptor"]
        self.assertEqual(descriptor["fixedSequences"],["ACDE"])
        self.assertEqual(len(descriptor["nativeProjection"]["projection"][0]["constructs"]),2)
        result=ProtoDesignAdapter().generate(bundle,self.output/"subset")
        self.assertEqual([c["sequence"] for c in result["candidates"]],["ACDE"])

    def test_descriptor_mismatch_rejects_before_run(self):
        from autofold_worker.adapters.proto import ProtoDesignAdapter
        bundle=self.admit(self.bundle())
        bundle["nativeExecution"]["descriptor"]["projection"][0]["stages"][0]["config"]["num_steps"]=99
        with self.assertRaisesRegex(ProtocolError,"changed after launch admission"):
            ProtoDesignAdapter().generate(bundle,self.output/"result")
        self.assertFalse((self.output/"result/generation-runs/index.json").exists())

    def test_fresh_legacy_builders_and_wrapped_public_methods_rejected(self):
        from types import SimpleNamespace, MethodType
        from autofold_worker.proto_trial import load_authored_trial
        from autofold_worker.adapters.proto import _load_program
        bundle=self.bundle()
        with self.assertRaisesRegex(TypeError,"legacy build_program"):
            load_authored_trial(SimpleNamespace(build_program=lambda b:None),bundle)
        module=_load_program(Path(bundle["programPath"]))
        original=module.build_trial
        def wrapped(ctx):
            trial=original(ctx);trial.program.run=lambda:None;return trial
        module.build_trial=wrapped
        with self.assertRaisesRegex(ProtocolError,"original native Program.run"):
            load_authored_trial(module,bundle)
        def replaced_sample(ctx):
            trial=original(ctx);generator=trial.program.optimizers[0].generators[0]
            generator.sample=MethodType(lambda self:None,generator);return trial
        module.build_trial=replaced_sample
        with self.assertRaisesRegex(ProtocolError,"base Generator.sample"):
            load_authored_trial(module,bundle)

    def test_latest_adapter_has_no_absent_marker_execution_fallback(self):
        from autofold_worker.adapters.proto import ProtoDesignAdapter
        with patch("autofold_worker.adapters.proto._prepare_runtime", side_effect=AssertionError("Must reject before imports")):
            with self.assertRaisesRegex(ProtocolError,"requires nativeExecution"):
                ProtoDesignAdapter().generate({"programPath":"unbound.py"},self.output)

    def test_common_protocol_binds_worker_selectors_and_actual_reservations(self):
        import copy
        bundle=self.admit(self.bundle());validate_native_execution(bundle)
        for mutate in (lambda b:b.pop("worker"),lambda b:b["nativeExecution"]["outputs"][0].update(lane=1),
                       lambda b:b["nativeExecution"]["resources"].update(reservedEvaluationWallSeconds=1),
                       lambda b:b["nativeExecution"]["resources"].update(maximumWorkerWallSeconds=float("inf"))):
            forged=copy.deepcopy(bundle);mutate(forged)
            with self.assertRaises(ProtocolError):validate_native_execution(forged)

    def test_fixed_guard_rejects_unassigned_sampling_and_request_before_effect(self):
        from autofold_worker.adapters.proto import _load_program
        from autofold_worker.proto_trial import load_authored_trial
        from autofold_worker.native_search import NativeSearchObserver
        from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig
        from proto_language.core import Segment
        from proto_tools import ToolRegistry
        from proto_tools.utils.execution_observer import ExecutionCancelled
        bundle=self.bundle(self.fixed_path());bundle["intent"]="negative_control"
        trial=load_authored_trial(_load_program(Path(bundle["programPath"])),bundle)
        generator=RandomProteinGenerator(RandomProteinGeneratorConfig());generator.assign(Segment(length=4,sequence_type="protein"))
        original=list(generator.segment.proposal_sequences)
        with NativeSearchObserver(trial.program,trial.fixed_control.observer_budget(1),self.output,forbid_work=True):
            with self.assertRaisesRegex(ExecutionCancelled,"cannot sample"):
                generator.sample()
        spec=ToolRegistry.get("boltz2-prediction")
        inputs=spec.input_model(complexes=[["ACDE","ACDE"]]);config=spec.config_model(use_msa=False)
        with NativeSearchObserver(trial.program,trial.fixed_control.observer_budget(1),self.output,forbid_work=True):
            with self.assertRaisesRegex(ExecutionCancelled,"registered requests"):
                spec.function(inputs,config)
        self.assertEqual(generator.segment.proposal_sequences,original)

    def test_constructor_tool_request_rejected_in_contained_inspection(self):
        path=self.fixed_path("    from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig\n    generator=RandomProteinGenerator(RandomProteinGeneratorConfig());generator.assign(segment);generator.sample()\n")
        bundle=self.bundle(path);bundle["intent"]="negative_control"
        result=subprocess.run([str(ROOT/".autofold/envs/proto/bin/python"),"-B","-m","autofold_worker.inspection","describeTrial",str(path)],
            input=json.dumps(bundle),capture_output=True,text=True,timeout=15,env={**os.environ,"PYTHONPATH":str(PROTO)+":"+str(PROTO/"proto-tools")+":"+str(ROOT/"backend/worker"),"CUDA_VISIBLE_DEVICES":"","HF_HUB_OFFLINE":"1","TRANSFORMERS_OFFLINE":"1","PYTHONDONTWRITEBYTECODE":"1"})
        self.assertNotEqual(result.returncode,0)
        self.assertIn("cannot sample",result.stderr)

    def test_worker_only_constructor_sampling_and_run_are_denied_before_body(self):
        from autofold_worker.adapters.proto import ProtoDesignAdapter
        from proto_tools.utils.execution_observer import ExecutionCancelled
        for action in ("generator.sample()", "Program([optimizer],1,compute=nullcontext()).run()"):
            callback="    from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig\n    generator=RandomProteinGenerator(RandomProteinGeneratorConfig());generator.assign(segment)\n    if ctx.get('nativeExecution'):\n        "+action+"\n"
            bundle=self.bundle(self.fixed_path(callback));bundle["intent"]="negative_control";self.admit(bundle)
            with self.assertRaisesRegex(ExecutionCancelled,"construction|forbidden"):
                ProtoDesignAdapter().generate(bundle,self.output/"conditional")
            calls=json.loads((self.output/"conditional/native-search/calls.json").read_text())
            self.assertEqual(calls["counts"],{"proposals":0,"samplingCalls":0,"toolCalls":0})

    def test_worker_only_constructor_hang_is_bounded_before_scientific_run(self):
        from autofold_worker.adapters.proto import ProtoDesignAdapter
        from autofold_worker.native_search import NativeExecutionStopped
        callback="    if ctx.get('nativeExecution'):\n        import time\n        time.sleep(10)\n"
        bundle=self.bundle(self.fixed_path(callback,wall=1));bundle["intent"]="negative_control";self.admit(bundle)
        import time
        started=time.monotonic()
        with self.assertRaisesRegex(NativeExecutionStopped,"wall-time deadline"):
            ProtoDesignAdapter().generate(bundle,self.output/"conditional")
        self.assertLess(time.monotonic()-started,3)
        self.assertFalse((self.output/"conditional/native-search/receipt.json").exists())

    def test_search_limit_denies_sampling_without_rewriting_optimizer_parameters(self):
        from autofold_worker.adapters.proto import ProtoDesignAdapter
        from proto_tools.utils.execution_observer import ExecutionCancelled
        path=self.output/"bounded.py"
        source=(ROOT/"backend/worker/examples/native_search_trial.py").read_text().replace("maximum_proposals=32","maximum_proposals=1")
        path.write_text(source);bundle=self.admit(self.bundle(path))
        config=json.loads(json.dumps(bundle["nativeExecution"]["descriptor"]["projection"][0]["stages"][0]["config"]))
        with self.assertRaisesRegex(ExecutionCancelled,"proposals"):
            ProtoDesignAdapter().generate(bundle,self.output/"result")
        receipt=json.loads((self.output/"result/native-search/calls.json").read_text())
        self.assertEqual(receipt["counts"]["samplingCalls"],0)
        self.assertEqual(bundle["nativeExecution"]["descriptor"]["projection"][0]["stages"][0]["config"],config)

    def test_native_fixed_control_hang_has_a_real_wall_deadline(self):
        from autofold_worker.adapters.proto import ProtoDesignAdapter
        from autofold_worker.native_search import NativeExecutionStopped
        # Native Program.run is retained. An authored optimizer callback blocks.
        callback="    def hung(*args, **kwargs):\n        import time\n        time.sleep(10)\n    optimizer.custom_logging=hung\n"
        bundle=self.bundle(self.fixed_path(callback,wall=1));bundle["intent"]="negative_control";self.admit(bundle)
        import time
        started=time.monotonic()
        with self.assertRaisesRegex(NativeExecutionStopped,"wall-time deadline"):
            ProtoDesignAdapter().generate(bundle,self.output/"result")
        self.assertLess(time.monotonic()-started,3)

    def test_fresh_deadline_cannot_be_swallowed_by_ordinary_native_callbacks(self):
        from autofold_worker.adapters.proto import ProtoDesignAdapter
        from autofold_worker.native_search import NativeExecutionStopped
        callback="    def hung(*args, **kwargs):\n        import time\n        while True:\n            try:\n                time.sleep(10)\n            except Exception:\n                pass\n    optimizer.custom_logging=hung\n"
        bundle=self.bundle(self.fixed_path(callback,wall=1));bundle["intent"]="negative_control";self.admit(bundle)
        import time
        started=time.monotonic()
        with self.assertRaisesRegex(NativeExecutionStopped,"wall-time deadline"):
            ProtoDesignAdapter().generate(bundle,self.output/"result")
        self.assertLess(time.monotonic()-started,3)

    def test_fractional_remaining_deadline_is_not_extended_and_missing_timer_fails_closed(self):
        from autofold_worker.adapters.proto import _run_with_hard_deadline
        from autofold_worker.native_search import NativeExecutionStopped
        import time, signal
        started=time.monotonic()
        with self.assertRaises(NativeExecutionStopped):
            _run_with_hard_deadline(lambda:time.sleep(2),"fractional",0.05)
        self.assertLess(time.monotonic()-started,0.5)
        with patch.object(signal,"setitimer",None):
            # An unavailable implementation must not invoke the callback.
            with self.assertRaises(ProtocolError):
                _run_with_hard_deadline(lambda:self.fail("unbounded body ran"),"missing",1)
