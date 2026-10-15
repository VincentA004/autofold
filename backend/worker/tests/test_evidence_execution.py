from __future__ import annotations
import copy, json, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from autofold_worker.evidence_pipeline_v3 import _enrich_v4
from autofold_worker.program_inspection import inspect_static_construction
from autofold_worker.compatibility.proto_v1 import _validate_static_construction

class EvidenceExecutionTest(unittest.TestCase):
    def fixture(self, root):
        target=root/'target.json';target.write_text(json.dumps({"chains":[{"sequence":"ACDE"}]}))
        stages=[{"id":"first","models":[{"id":"boltz2-prediction","version":"a"*40}],"dependsOn":[],"required":True,"allowedSkips":[],"budget":{"maximumGpuSeconds":20}},
                {"id":"second","models":[{"id":"chai1-prediction","version":"a"*40}],"dependsOn":["first"],"required":True,"allowedSkips":[],"budget":{"maximumGpuSeconds":20}}]
        bundle={"runId":"run_fixture","trialId":"trl_fixture","format":"autofold.trial-bundle.v4","targetArtifactHash":"target","targetArtifactPath":str(target),"evidenceAdapter":{"sourceHash":"adapter"},"proto":{"languageCommit":"a"*40,"toolsCommit":"a"*40},"programHash":"program","pipelineHash":"policy","modality":"short_peptide","seeds":[7,11],"pipeline":{"stages":stages}}
        candidates={"candidates":[{"id":"one","sequence":"ACDEFG"},{"id":"two","sequence":"HIKLMN"}]}
        calls=[]
        class Config:
            model_fields={"seed":object(),"timeout":object()}
            def __init__(self,**values):self.values=values
            def model_dump(self,**_):return self.values
        class Metrics:
            def model_dump(self,**_):return {"iptm":0.8,"ptm":0.7}
        def get(key):
            def infer(inputs,config):
                calls.append((key,inputs['complexes'],config.values))
                return SimpleNamespace(success=True,structures=[SimpleNamespace(structure_cif="data_fixture\n#\n",metrics=Metrics())])
            return SimpleNamespace(key=key,category="structure_prediction",config_model=Config,input_model=lambda **x:x,function=infer)
        return bundle,candidates,SimpleNamespace(get=get),calls
    def test_unconditional_native_calls_preserve_scores_metrics_artifact_lineage_and_seed_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);bundle,candidates,registry,calls=self.fixture(root)
            outputs=[]; indexes=[]
            for backend in ['legacy_dag_v1','native_tool_sequence_v1']:
                current=copy.deepcopy(bundle);current['pipeline']['executionBackend']=backend
                with patch('autofold_worker.evidence_pipeline_v3.time.monotonic',return_value=0):
                    outputs.append(_enrich_v4(current,copy.deepcopy(candidates),root/backend,registry))
                indexes.append(json.loads((root/backend/'model-runs/index.json').read_text()))
            self.assertEqual(outputs[0],outputs[1]);self.assertEqual(indexes[0],indexes[1])
            self.assertEqual(calls[:8],calls[8:]);self.assertEqual(len(calls),16)
            for entry in indexes[1]['entries']:
                self.assertEqual(len(entry['parentArtifactHashes']),1 if entry['stage']=='second' else 0)
    def test_native_path_rejects_all_unsupported_graphs_before_any_model_or_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);bundle,candidates,registry,calls=self.fixture(root)
            bundle['pipeline']['executionBackend']='native_tool_sequence_v1'
            for field,value in [('condition',{'source':'first','metric':'iptm','operator':'gt','value':0}),('candidateRouting',{'source':'first','metric':'iptm','direction':'maximize','maximumCandidates':1})]:
                trial=copy.deepcopy(bundle);trial['pipeline']['stages'][1][field]=value
                with self.assertRaisesRegex(ValueError,'conditional or routed'):_enrich_v4(trial,candidates,root/'reject',registry)
                self.assertEqual(calls,[]);self.assertFalse((root/'reject').exists())
            trial=copy.deepcopy(bundle);trial['pipeline']['stages'].reverse()
            with self.assertRaisesRegex(ValueError,'frozen execution order'):_enrich_v4(trial,candidates,root/'reject',registry)
            self.assertEqual(calls,[])
    def test_unknown_backend_cannot_fall_back_to_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);bundle,candidates,registry,calls=self.fixture(root)
            bundle['pipeline']['executionBackend']='invented'
            with self.assertRaisesRegex(ValueError,'Unknown trusted'):_enrich_v4(bundle,candidates,root/'reject',registry)
            self.assertEqual(calls,[])
    def test_shared_fixed_inspection_ignores_documentation_and_rejects_executable_changes(self):
        def cpu_function(): pass
        constraint=SimpleNamespace(function=cpu_function,function_config={'threshold':0.4},threshold=None,inputs=[SimpleNamespace(sequence_length=6)])
        optimizer=SimpleNamespace(generators=[],constraints=[constraint],config=SimpleNamespace(proposal_source='existing_results'),num_samples=1,num_results=1,proposal_batch_size=1)
        program=SimpleNamespace(optimizers=[optimizer],constructs=[SimpleNamespace(segments=[SimpleNamespace(result_sequences=['ACDEFG'])])],num_results=1)
        frozen=inspect_static_construction(program,semantic=True)
        self.assertEqual(_validate_static_construction(program,{'pipeline':{'staticConstruction':frozen}}),['ACDEFG'])
        cpu_function.__doc__='Different documentation only'
        self.assertEqual(inspect_static_construction(program,semantic=True),frozen)
        constraint.function_config={'threshold':0.5}
        with self.assertRaisesRegex(Exception,'changed after launch'):_validate_static_construction(program,{'pipeline':{'staticConstruction':frozen}})
