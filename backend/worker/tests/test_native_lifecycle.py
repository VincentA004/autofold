"""Actual scoped native worker regressions; all tools are local CPU fixtures."""
from __future__ import annotations
from contextlib import nullcontext
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
from pydantic import BaseModel, Field
from proto_tools import ToolRegistry
from proto_tools.utils.tool_io import BaseToolInput, BaseToolOutput
from proto_tools.utils import BaseConfig
from proto_tools.utils.execution_observer import ExecutionCancelled, ObservationPublicationError
from proto_tools.utils.tool_cache import _program_tool_cache
from autofold_worker.evidence_pipeline_v3 import _capture_scoped_model
from autofold_worker.native_lifecycle import RequestRecorder, measurement_scope

COUNTS={"root":0,"child":0}
class Inputs(BaseToolInput):
    complexes: list[list[str]] = Field(title="Complexes",description="Local CPU fixture inputs")
class Config(BaseConfig):
    seed: int = Field(default=7,title="Seed",description="Frozen fixture seed")
    timeout: int = Field(default=2,title="Timeout",description="Fixture request timeout")
    mode: str = Field(default="normal",title="Mode",description="CPU boundary regression mode")
class Metrics(BaseModel):
    iptm: float=0.8
    ptm: float=0.7
class Structure(BaseModel):
    metrics: Metrics=Field(default_factory=Metrics)
    structure_cif: str="data_cpu\n#\n"
class Output(BaseToolOutput):
    structures: list[Structure]
    @classmethod
    def output_format_options(cls):return ["json"]
    @classmethod
    def output_format_default(cls):return "json"
    def _export_output(self,*args,**kwargs):raise AssertionError("No fixture export")

@ToolRegistry.register(key="autofold-worker-cpu-nested",label="CPU nested fixture",category="structure_prediction",description="Local CPU request scope regression",input_class=Inputs,config_class=Config,output_class=Output,cacheable=True)
def nested(inputs,config,instance=None):
    COUNTS["child"]+=1
    return Output(structures=[Structure()])

@ToolRegistry.register(key="autofold-worker-cpu-measurement",label="CPU frozen fixture",category="structure_prediction",description="Local CPU frozen lifecycle regression",input_class=Inputs,config_class=Config,output_class=Output,cacheable=True)
def measure(inputs,config,instance=None):
    COUNTS["root"]+=1
    if config.mode=="nested":
        nested(inputs,Config())
    if config.mode=="sleep":
        while True:
            try:time.sleep(10)
            except Exception:pass
    return Output(structures=[Structure()])

class NativeLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix="autofold-scoped-cpu-")
        self.output=Path(self.temporary.name)
        COUNTS.update(root=0,child=0)
        self.cache=_program_tool_cache.set(None)
    def tearDown(self):
        _program_tool_cache.reset(self.cache)
        self.temporary.cleanup()
    def capture(self,mode="normal",seconds=2):
        return _capture_scoped_model(ToolRegistry.get("autofold-worker-cpu-measurement"),Inputs(complexes=[["ACDE","CDEF"]]),Config(mode=mode),self.output,"autofold-worker-cpu-measurement",seconds)
    def test_whole_frozen_measurement_captures_actual_nested_parent_and_original_cache_branches_once(self):
        original=ToolRegistry.dispatch_backend_configured()
        metrics,cif,receipt,wall=self.capture("nested")
        self.assertEqual(COUNTS,{"root":1,"child":1})
        self.assertEqual(metrics,{"iptm":0.8,"ptm":0.7})
        self.assertEqual(cif,"data_cpu\n#\n")
        self.assertEqual(len(receipt["entries"]),2)
        root=next(r for r in receipt["entries"] if r["parentRequestId"] is None)
        child=next(r for r in receipt["entries"] if r["parentRequestId"] is not None)
        self.assertEqual(root["requestId"],receipt["rootRequestId"])
        self.assertEqual(child["parentRequestId"],root["requestId"])
        self.assertTrue(all(r["status"]=="completed" and r["cacheOrigin"]=="cache_disabled" and r["wallSeconds"]<=wall for r in receipt["entries"]))
        self.assertEqual(ToolRegistry.dispatch_backend_configured(),original)
    def test_fresh_model_full_call_deadline_covers_cold_work_and_cannot_be_swallowed_as_Exception(self):
        from autofold_worker.native_search import NativeExecutionStopped
        started=time.monotonic()
        with self.assertRaisesRegex(NativeExecutionStopped,"wall-time deadline"):
            self.capture("sleep",0.05)
        self.assertLess(time.monotonic()-started,0.5)
        journal=json.loads((self.output/"native-requests.json").read_text())
        self.assertEqual(len(journal["entries"]),1)
        self.assertEqual(journal["entries"][0]["status"],"failed")
        self.assertEqual(COUNTS["root"],1)
    def test_completed_publication_loss_reaches_worker_boundary_and_preserves_original_intent_without_retry(self):
        publish=RequestRecorder._publish
        def lose(recorder):
            if recorder.records and recorder.records[0]["status"]=="completed":raise OSError("CPU injected terminal publication loss")
            return publish(recorder)
        with patch.object(RequestRecorder,"_publish",lose):
            with self.assertRaises(ObservationPublicationError) as error:self.capture()
        self.assertIsInstance(error.exception.__cause__,OSError)
        self.assertEqual(COUNTS["root"],1)
        journal=json.loads((self.output/"native-requests.json").read_text())
        self.assertEqual(journal["entries"][0]["status"],"started")
        self.assertFalse((self.output/"model-run.json").exists())
        with self.assertRaises(ExecutionCancelled):measure(Inputs(complexes=[["ACDE"]]),Config())
        self.assertEqual(COUNTS["root"],1)
    def test_native_capture_getter_cannot_issue_extra_unassigned_root_request_after_primary_call(self):
        class EscapingMetrics:
            def model_dump(self,mode):
                nested(Inputs(complexes=[["ACDE"]]),Config())
                return {"iptm":0.8,"ptm":0.7}
        class EscapingStructure:
            metrics=EscapingMetrics()
            structure_cif="data_cpu\n"
        original=ToolRegistry.get("autofold-worker-cpu-measurement")
        class GetterSpec:
            def function(self,inputs,config):
                measure(inputs,config)
                return type("Prediction",(),{"success":True,"structures":[EscapingStructure()]})()
        with self.assertRaisesRegex(ExecutionCancelled,"additional or different root"):
            _capture_scoped_model(GetterSpec(),Inputs(complexes=[["ACDE"]]),Config(),self.output,original.key,2)
        self.assertEqual(COUNTS,{"root":1,"child":0})
    def test_actual_model_artifacts_bind_frozen_pool_model_seed_and_cache_receipts(self):
        from autofold_worker.evidence_pipeline_v3 import _enrich_v4
        target=self.output/"target.json";target.write_text(json.dumps({"chains":[{"sequence":"ACDE"}]}))
        models=[{"id":key,"toolKey":key,"version":"cpu-fixture","config":{}} for key in ("autofold-worker-cpu-measurement","autofold-worker-cpu-nested")]
        bundle={"runId":"run_cpu","trialId":"trial_cpu","modality":"short_peptide","seeds":[7],"programHash":"sha256:"+"a"*64,
            "targetArtifactPath":str(target),"targetArtifactHash":"sha256:"+"b"*64,"evidenceAdapter":{"sourceHash":"sha256:"+"c"*64},
            "proto":{"languageCommit":"d"*40,"toolsCommit":"e"*40},"pipelineHash":"sha256:"+"f"*64,
            "nativeExecution":{"observation":"scoped_native_lifecycle_v1","resources":{"invocationReservations":[{"stageId":"frozen","perRequestTimeoutSeconds":2}]}},
            "pipeline":{"executionBackend":"native_tool_sequence_v1","stages":[{"id":"frozen","role":"scoring","models":models,"budget":{"maximumGpuSeconds":2},"allowedSkips":[]}]}}
        candidates={"candidates":[{"id":"one","sequence":"ACDE","seed":7},{"id":"two","sequence":"CDEF","seed":7}]}
        result=_enrich_v4(bundle,candidates,self.output,ToolRegistry)
        self.assertEqual(len(result["candidates"]),2)
        index=json.loads((self.output/"model-runs/index.json").read_text())
        self.assertEqual(len(index["entries"]),4)
        observed=set()
        for entry in index["entries"]:
            artifact=json.loads((self.output/entry["artifactPath"]).read_text())
            receipt=artifact["runtime"]["requestObservation"]
            self.assertEqual(len(receipt["entries"]),1)
            root=receipt["entries"][0]
            self.assertEqual(root["tool"],artifact["model"]["id"])
            self.assertEqual(root["requestId"],receipt["rootRequestId"])
            self.assertIsNone(root["parentRequestId"])
            self.assertEqual(root["cacheOrigin"],"cache_disabled")
            from autofold_worker.native_search import digest
            self.assertEqual(artifact["parametersHash"],digest({"tool":root["tool"],"seed":artifact["seed"],"configHash":root["configHash"]}))
            self.assertTrue(root["inputHash"].startswith("sha256:"))
            self.assertLessEqual(root["wallSeconds"],artifact["runtime"]["wallSeconds"])
            self.assertLessEqual(artifact["runtime"]["wallSeconds"],2)
            observed.add((artifact["candidateId"],artifact["model"]["id"],artifact["seed"]))
        self.assertEqual(len(observed),4)
        self.assertEqual(COUNTS,{"root":2,"child":2})
    def test_original_full_call_cache_miss_then_hit_uses_one_physical_cpu_fixture_execution(self):
        from proto_tools.utils.tool_cache import ToolCache
        token=_program_tool_cache.set(ToolCache())
        try:
            first=self.capture();second=self.capture()
        finally:_program_tool_cache.reset(token)
        self.assertEqual(COUNTS["root"],1)
        self.assertEqual(first[2]["entries"][0]["cacheOrigin"],"cache_miss")
        self.assertEqual(second[2]["entries"][0]["cacheOrigin"],"cache_hit")
        self.assertNotEqual(first[2]["rootRequestId"],second[2]["rootRequestId"])
    def test_raw_thread_after_native_capture_and_pure_publication_cannot_dispatch(self):
        import threading
        captured=self.capture()
        (self.output/"pure.json").write_text(json.dumps({"metrics":captured[0],"receipt":captured[2]}))
        errors=[]
        def escaped():
            try:measure(Inputs(complexes=[["ACDE","CDEF"]]),Config())
            except BaseException as error:errors.append(error)
        thread=threading.Thread(target=escaped);thread.start();thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors),1)
        self.assertIsInstance(errors[0],ExecutionCancelled)
        self.assertEqual(COUNTS["root"],1)
    def test_stage_error_retains_actual_native_publication_error_type(self):
        import argparse
        from autofold_worker import stage_runner
        args=argparse.Namespace(result=self.output/"stage.json",stage="generation")
        with patch.object(stage_runner,"parser") as parser,patch.object(stage_runner,"run",side_effect=ObservationPublicationError("publication unresolved")):
            parser.return_value.parse_args.return_value=args
            self.assertEqual(stage_runner.main([]),2)
        error=json.loads((self.output/"stage.error.json").read_text())
        self.assertEqual(error["errorType"],"ObservationPublicationError")

if __name__=="__main__":unittest.main()
