from __future__ import annotations
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as N
from autofold_worker.compatibility.native_monitor_v1 import NativeSearchObserver
from autofold_worker.native_search import NativeSearch, NativeOutput, describe_native, select_native, capture_native, _generation_seed_roles
from autofold_worker.protocol import ProtocolError

class Registry:
    backend = None
    effects = []
    @classmethod
    def configure_dispatch_backend(cls, backend): cls.backend = backend
    @classmethod
    def clear_dispatch_backend(cls): cls.backend = None
    @classmethod
    def dispatch_backend_configured(cls): return cls.backend is not None
    @classmethod
    def list_all(cls): return [cls.get("cpu-tool")]
    @classmethod
    def get(cls, key):
        def call(inputs, config):
            value = cls.backend(key, inputs, config) if cls.backend else None
            if value is not None: return value
            cls.effects.append(key)
            return NResult()
        return N(function=call)
class NResult:
    success = True
    def model_dump(self, **_): return {"value": 7, "success": True}

def seq(text): return N(sequence=text,sequence_type="protein",metadata={},logits=None,structure=None)
class TestGenerator(N):
    def sample(self, *args, **kwargs):
        return self._sample(*args, **kwargs)

def make():
    segment=N(label="binder",sequence_type="protein",sequence_length=4,original_sequence=seq("AAAA"),result_sequences=[seq("AAAA")],proposal_sequences=[seq("AAAA"),seq("CCCC")])
    construct=N(label="design",segments=[segment],joined_sequences=[seq("AAAA")])
    calls=[]
    def sample(*args,**kwargs): calls.append((args,kwargs))
    generators=[TestGenerator(_spec=N(key="same-type",tools_called=[]),config={},segments=[segment],_sample=sample) for _ in range(2)]
    program=N(num_results=1,constructs=[construct],optimizers=[N(config={},num_results=1,generators=[g],constraints=[]) for g in generators])
    return program, generators, calls

def budget(**overrides):
    values=dict(maximum_candidates=1,maximum_proposals=10,maximum_sampling_calls=5,maximum_tool_calls=4,maximum_wall_seconds=30,outputs=(NativeOutput("design"),),allowed_tools=("cpu-tool",))
    return NativeSearch(**(values|overrides))

class NativeSearchTests(unittest.TestCase):
    def setUp(self): Registry.backend=None; Registry.effects=[]
    def test_same_type_stages_preserve_conditioning_and_optimizer_settings(self):
        program, generators, calls=make(); description=describe_native(program,budget(),{})
        self.assertEqual([s["generators"][0]["key"] for s in description["projection"][0]["stages"]],["same-type","same-type"])
        with tempfile.TemporaryDirectory() as d:
            with NativeSearchObserver(program,budget(),Path(d),Registry) as observer:
                generators[0].sample({"structure":"condition"}, temperature=0.5)
                generators[1].sample()
                observer.verify()
            self.assertEqual(observer.counts["proposals"],4)
            self.assertEqual(calls[0],(({"structure":"condition"},),{"temperature":0.5}))
            self.assertEqual(program.optimizers[0].config,{})
            self.assertIsNone(Registry.backend)
    def test_search_proposals_are_not_final_candidates_and_exhaustion_prevents_work(self):
        program, generators, calls=make()
        with tempfile.TemporaryDirectory() as d:
            with NativeSearchObserver(program,budget(maximum_proposals=4),Path(d),Registry) as observer:
                generators[0].sample();generators[1].sample()
                with self.assertRaisesRegex(ProtocolError,"proposals"):
                    generators[0].sample()
            self.assertEqual(len(calls),2)
            self.assertEqual(len(select_native(program,budget())),1)
    def test_external_cli_is_sampling_and_inherits_remaining_wall_authority(self):
        for key in ["boltzgen-binder", "pxdesign-binder"]:
            program, generators, _ = make()
            generator = generators[0]
            generator._spec.key = key
            calls = []
            generator._sample = lambda: calls.append(generator._autofold_timeout)
            with tempfile.TemporaryDirectory() as d:
                with NativeSearchObserver(program, budget(allowed_tools=()), Path(d), Registry) as observer:
                    generator.sample()
                    observer.verify()
                self.assertEqual(observer.counts["samplingCalls"], 1)
                self.assertEqual(observer.counts["toolCalls"], 0)
                self.assertGreater(calls[0], 0)
                self.assertLessEqual(calls[0], 30)
                self.assertFalse(hasattr(generator, "_autofold_timeout"))
                self.assertEqual(Registry.effects, [])

    def test_external_cli_preserves_an_existing_stricter_timeout_after_failure(self):
        program, generators, _ = make()
        generator = generators[0]
        generator._spec.key = "boltzgen-binder"
        generator._autofold_timeout = 1
        def fail():
            self.assertLessEqual(generator._autofold_timeout, 1)
            raise RuntimeError("Recorded CLI failure")
        generator._sample = fail
        with tempfile.TemporaryDirectory() as d:
            with NativeSearchObserver(program, budget(allowed_tools=()), Path(d), Registry) as observer:
                with self.assertRaisesRegex(RuntimeError, "Recorded CLI failure"):
                    generator.sample()
            self.assertEqual(generator._autofold_timeout, 1)
            self.assertEqual(observer.samplings[0]["status"], "failed")

    def test_declared_tool_calls_record_exact_typed_hashes_and_no_extra_effect(self):
        program,_,_=make()
        with tempfile.TemporaryDirectory() as d:
            with NativeSearchObserver(program,budget(maximum_tool_calls=1),Path(d),Registry) as observer:
                Registry.get("cpu-tool").function({"sequence":"AAAA"},{})
                with self.assertRaisesRegex(ProtocolError,"toolCalls"):
                    Registry.get("cpu-tool").function({"sequence":"CCCC"},{})
            self.assertEqual(Registry.effects,["cpu-tool"])
            self.assertEqual(observer.calls[0]["status"],"completed")
            self.assertTrue(observer.calls[0]["inputHash"].startswith("sha256:"))
    def test_undeclared_tool_and_implicit_remote_msa_never_dispatch(self):
        for key,config in [("other",{}),("cpu-tool",{"use_msa":True})]:
            program,_,_=make()
            with tempfile.TemporaryDirectory() as d:
                with NativeSearchObserver(program,budget(),Path(d),Registry) as observer:
                    with self.assertRaises(ProtocolError): Registry.get(key).function({},config)
                    with self.assertRaises(ProtocolError): observer.verify()
            self.assertEqual(Registry.effects,[])
    def test_predictor_auto_msa_is_rejected_before_preprocessing(self):
        program,_,_=make()
        with tempfile.TemporaryDirectory() as d:
            with NativeSearchObserver(program,budget(allowed_tools=("boltz2-prediction",)),Path(d),Registry) as observer:
                with self.assertRaisesRegex(ProtocolError,"MSA"):
                    Registry.get("boltz2-prediction").function({}, {"use_msa": None})
        self.assertEqual(Registry.effects,[])

    def test_explicit_final_selector_does_not_submit_fixed_partners(self):
        program,_,_=make();construct=program.constructs[0]
        self.assertEqual(select_native(program,budget(),initial=True),[])
        fixed=N(label="target",sequence_type="protein",sequence_length=4,original_sequence=seq("CCCC"),result_sequences=[seq("CCCC")])
        construct.segments.append(fixed);construct.joined_sequences=[seq("AAAACCCC")]
        selected=select_native(program,budget(outputs=(NativeOutput("design","binder"),)))
        self.assertEqual([s.sequence for s,_ in selected],["AAAA"])
        self.assertEqual([s.sequence for s,_ in select_native(program,budget())],["AAAACCCC"])
        fixed.sequence_type="rna"
        with self.assertRaisesRegex(ProtocolError,"protein-sequence"): select_native(program,budget(),initial=True)
    def test_final_output_limit_fails_instead_of_silent_truncation(self):
        program,_,_=make();program.constructs[0].segments[0].result_sequences=[seq("AAAA"),seq("CCCC")]
        with self.assertRaisesRegex(ProtocolError,"final outputs"):select_native(program,budget())
    def test_capture_preserves_constraint_metadata_history_and_instance_identity(self):
        program,generators,_=make();program.optimizers[0].history=[{"accepted":False,"energy":float("inf")}]
        program.constructs[0].segments[0].result_sequences[0].metadata={"constraints":{"confidence":{"score":0.4,"raw":60}}}
        admitted=describe_native(program,budget(),{})
        with tempfile.TemporaryDirectory() as d:
            with NativeSearchObserver(program,budget(),Path(d),Registry) as observer: generators[0].sample()
            self.assertEqual(capture_native(program,budget(),admitted,observer,{"runId":"original","programHash":"sha256:x"},Path(d)),["AAAA"])
            receipt=json.loads((Path(d)/"native-search/receipt.json").read_text())
            self.assertEqual(receipt["lanes"][0]["stages"][0]["history"][0]["energy"],"inf")
            self.assertEqual(receipt["selected"][0]["sequence"]["metadata"]["constraints"]["confidence"]["raw"],60)
            self.assertNotEqual(admitted["projection"][0]["stages"][0]["generators"][0]["instanceId"],admitted["projection"][0]["stages"][1]["generators"][0]["instanceId"])
    def test_seed_roles_keep_declared_observed_and_evaluator_roles_separate(self):
        admitted={"projection":[{"lane":0,"programSeed":3051971263,"stages":[{
            "instanceId":"lane0.stage0","generators":[{"toolsCalled":["protein-mpnn-sample"]}],
            "constraints":[{"instanceId":"lane0.stage0.constraint0","function":{"name":"fixed_predictor"},
                "config":{"predictor_seed":99173}}]}]}]}
        calls=[{"requestId":"r-mpnn","tool":"protein-mpnn-sample","configSeed":1987514851},
            {"requestId":"r-boltz","tool":"boltz2-prediction","configSeed":99173}]
        roles=_generation_seed_roles({"generationSeed":3051971263,"seeds":[20260809]},admitted,calls)
        self.assertEqual(roles["hostGenerationSeed"]["value"],3051971263)
        self.assertEqual(roles["effectiveProgramSeeds"][0]["value"],3051971263)
        self.assertEqual(roles["declaredPredictorSeeds"][0]["value"],99173)
        self.assertEqual([item["seed"] for item in roles["observedToolConfigSeeds"]],[1987514851,99173])
        self.assertEqual(roles["evaluatorSeeds"]["values"],[20260809])
        self.assertIsNone(_generation_seed_roles({"seeds":[20260809]},admitted,calls))

    def test_seed_role_evidence_rejects_invalid_host_or_evaluator_seeds(self):
        admitted={"projection":[]}
        for bundle in ({"generationSeed":True,"seeds":[7]},
                       {"generationSeed":2**32,"seeds":[7]},
                       {"generationSeed":7,"seeds":[True]},
                       {"generationSeed":7,"seeds":[2**53]}):
            with self.subTest(bundle=bundle),self.assertRaises(ProtocolError):
                _generation_seed_roles(bundle,admitted,[])
    def test_modified_stage_or_objective_changes_admission(self):
        program,_,_=make();before=describe_native(program,budget(),{})
        program.optimizers[0].config={"num_steps":50}
        self.assertNotEqual(before,describe_native(program,budget(),{}))
    def test_native_portfolio_does_not_silently_ignore_legacy_lane_budgets(self):
        from autofold_worker.proto_portfolio import ProtoPortfolioProgram, ProtoPortfolioLane
        program,_,_=make();program.run=lambda:None
        portfolio=ProtoPortfolioProgram([ProtoPortfolioLane(program,maximum_candidates=1,maximum_gpu_seconds=20)])
        with self.assertRaisesRegex(ProtocolError,"legacy per-lane"):
            describe_native(portfolio,budget(),{})

    def test_exception_restores_original_wrappers(self):
        program,generators,_=make();original=generators[0]._sample
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(RuntimeError):
                with NativeSearchObserver(program,budget(),Path(d),Registry): raise RuntimeError("fault")
        self.assertIs(generators[0]._sample,original)
        self.assertIsNone(Registry.backend)


class NativePinnedIntegrationTests(unittest.TestCase):
    def test_actual_two_stage_proto_worker_capture_and_frozen_reconstruction(self):
        import os, subprocess
        root=Path(__file__).resolve().parents[3]
        python=root/".autofold/envs/proto/bin/python"
        if not python.is_file(): self.skipTest("Optional pinned Proto environment is absent")
        source = """
import hashlib, json, tempfile, subprocess
from pathlib import Path
from autofold_worker.adapters.proto import _load_program
from autofold_worker.compatibility.proto_v1 import HistoricalProtoDesignAdapter as ProtoDesignAdapter
from autofold_worker.proto_trial import load_authored_trial
from autofold_worker.native_search import describe_native
root=Path.cwd()
proto=root.parent/'repo_store/github.com-evo-design-proto-language'
commit=lambda p:subprocess.check_output(['git','-C',str(p),'rev-parse','HEAD'],text=True).strip()
path=root/'backend/worker/examples/native_search_trial.py'
bundle={'format':'autofold.trial-bundle.v4','programPath':str(path),'programHash':'sha256:'+hashlib.sha256(path.read_bytes()).hexdigest(),
'proto':{'root':str(proto),'languageCommit':commit(proto),'toolsCommit':commit(proto/'proto-tools')},
'runId':'run_test_native','trialId':'trl_test_native','seeds':[20260809],'candidateBudget':1,'submissionSize':1,
'evaluator':{'id':'fixture','version':'1'},'targetArtifactHash':'sha256:'+'1'*64,'modality':'short_peptide','intent':'optimize'}
trial=load_authored_trial(_load_program(path),bundle)
admitted=describe_native(trial.program,trial.search,bundle)
bundle['pipeline']={'nativeSearch':admitted,'authoredDiagnostics':[], 'generation':{'mode':'proto_program',
'generators':[{'id':'random-protein','version':bundle['proto']['languageCommit'],'toolsCalled':['random-protein-sample']}],
'budget':{'maximumCandidates':1,'maximumGpuSeconds':30}}}
with tempfile.TemporaryDirectory() as d:
 output=Path(d); candidates=ProtoDesignAdapter().generate(bundle,output)
 receipt=json.loads((output/'native-search/receipt.json').read_text())
 assert len(candidates['candidates'])==1
 assert receipt['counts']['proposals']>1
 assert receipt['admission']==admitted
 assert len(receipt['lanes'][0]['stages'])==2
 assert all(s['history'] for s in receipt['lanes'][0]['stages'])
 index=json.loads((output/'generation-runs/index.json').read_text())
 assert index['nativeSearch']['hash']=='sha256:'+hashlib.sha256((output/'native-search/receipt.json').read_bytes()).hexdigest()
 artifact=json.loads((output/index['entries'][0]['artifactPath']).read_text())
 assert len(artifact['generator']['components'][0]['parameters']['instances'])==2
 bundle['pipeline']['nativeSearch']['projection'][0]['stages'][0]['config']['num_steps']=99
 try: ProtoDesignAdapter().generate(bundle,output/'forged')
 except Exception as e: assert 'changed after launch admission' in str(e)
 else: raise AssertionError('tampered native construction admitted')
 print(json.dumps({'counts':receipt['counts'],'outputs':len(candidates['candidates'])}))
"""
        result=subprocess.run([str(python),"-c",source],cwd=root,env={**os.environ,"PYTHONPATH":str(root/"backend/worker"),"PYTHONDONTWRITEBYTECODE":"1","HF_HUB_OFFLINE":"1","TRANSFORMERS_OFFLINE":"1","CUDA_VISIBLE_DEVICES":"","MPLCONFIGDIR":"/private/tmp/autofold-proto-native-mpl"},capture_output=True,text=True,timeout=60)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        counts=json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(counts["outputs"],1)
        self.assertGreater(counts["counts"]["proposals"],1)

AUDIT_GLOBAL_COEFFICIENT = 1

def configurable_objective(value=1):
    return AUDIT_GLOBAL_COEFFICIENT * value

def external_module_objective(value=1):
    return json.dumps(value)

class NativeObservationBoundaryTests(unittest.TestCase):
    def setUp(self): Registry.backend=None; Registry.effects=[]

    def test_public_local_monitoring_preserves_an_active_profiler(self):
        import sys
        if not hasattr(sys, 'monitoring'): self.skipTest('Code-local monitoring requires Python 3.12+')
        old = sys.getprofile()
        def existing_profiler(*_): pass
        sys.setprofile(existing_profiler)
        try:
            program, _, _ = make()
            with tempfile.TemporaryDirectory() as directory:
                with NativeSearchObserver(program, budget(), Path(directory), Registry) as observer:
                    self.assertIs(sys.getprofile(), existing_profiler)
                    Registry.get('cpu-tool').function({}, {})
                    observer.verify()
                    self.assertEqual(observer.observation_mechanism, 'python_code_local_monitoring_v1')
                self.assertIs(sys.getprofile(), existing_profiler)
                self.assertEqual(observer.calls[0]['status'], 'completed')
        finally: sys.setprofile(old)

    def test_public_sample_and_private_implementation_identity_never_change(self):
        import inspect
        program, generators, _ = make()
        generator = generators[0]
        before = (generator.sample.__func__, generator._sample, inspect.signature(generator._sample), dict(vars(generator)))
        with tempfile.TemporaryDirectory() as directory:
            with NativeSearchObserver(program, budget(), Path(directory), Registry) as observer:
                self.assertIs(generator.sample.__func__, before[0])
                self.assertIs(generator._sample, before[1])
                self.assertEqual(inspect.signature(generator._sample), before[2])
                generator.sample('original-condition', temperature=0.5)
                observer.verify()
            self.assertEqual(vars(generator), before[3])
            self.assertEqual(observer.samplings[0]['status'], 'completed')
            self.assertEqual(observer.sampling_boundary, 'public_generator_sample_monitoring_v1')

    def test_threaded_public_samples_count_each_instance_once(self):
        import concurrent.futures
        program, generators, calls = make()
        with tempfile.TemporaryDirectory() as directory:
            with NativeSearchObserver(program, budget(), Path(directory), Registry) as observer:
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    list(pool.map(lambda generator: generator.sample(), generators))
                observer.verify()
            self.assertEqual(observer.counts['samplingCalls'], 2)
            self.assertEqual(observer.counts['proposals'], 4)
            self.assertEqual(len(calls), 2)
            self.assertTrue(all(sample['status'] == 'completed' for sample in observer.samplings))

    def test_unadmitted_generator_using_shared_public_code_cannot_sample(self):
        program, _, _ = make()
        _, outsiders, effects = make()
        with tempfile.TemporaryDirectory() as directory:
            with NativeSearchObserver(program, budget(), Path(directory), Registry):
                with self.assertRaisesRegex(ProtocolError, 'outside its admitted stages'):
                    outsiders[0].sample()
            self.assertEqual(effects, [])

    def test_missing_monitoring_fails_before_registry_effect_and_preserves_profiler(self):
        import sys
        from unittest.mock import patch
        program, generators, effects = make()
        original = generators[0]._sample
        previous = sys.getprofile()
        with tempfile.TemporaryDirectory() as directory, patch.object(sys, 'monitoring', None):
            with self.assertRaisesRegex(ProtocolError, 'Python 3.12'):
                with NativeSearchObserver(program, budget(), Path(directory), Registry):
                    generators[0].sample()
        self.assertIs(sys.getprofile(), previous)
        self.assertIs(generators[0]._sample, original)
        self.assertIsNone(Registry.backend)
        self.assertEqual(effects, [])

    def test_caught_limit_errors_do_not_disable_subsequent_entry_fences(self):
        program, generators, effects = make()
        with tempfile.TemporaryDirectory() as directory:
            with NativeSearchObserver(program, budget(maximum_sampling_calls=1), Path(directory), Registry) as observer:
                generators[0].sample()
                for _ in range(3):
                    with self.assertRaisesRegex(ProtocolError, 'samplingCalls'):
                        generators[0].sample()
                self.assertEqual(observer.counts['samplingCalls'], 1)
                self.assertEqual(len(effects), 1)

    def test_recursive_public_sampling_is_rejected_before_second_body(self):
        program, generators, effects = make()
        generator = generators[0]
        def recursive():
            effects.append('entered')
            generator.sample()
        generator._sample = recursive
        with tempfile.TemporaryDirectory() as directory:
            with NativeSearchObserver(program, budget(), Path(directory), Registry) as observer:
                with self.assertRaisesRegex(ProtocolError, 'recursively or concurrently'):
                    generator.sample()
            self.assertEqual(observer.counts['samplingCalls'], 1)
            self.assertEqual(effects, ['entered'])
            self.assertEqual(observer.samplings[0]['status'], 'failed')

    def test_failed_registry_setup_releases_monitoring_slot_without_method_mutation(self):
        import sys
        class FailingRegistry(Registry):
            @classmethod
            def configure_dispatch_backend(cls, backend):
                cls.backend = backend
                raise RuntimeError('setup failed')
        program, generators, _ = make()
        original = generators[0]._sample
        previous = [sys.monitoring.get_tool(i) for i in range(6)]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'setup failed'):
                with NativeSearchObserver(program, budget(), Path(directory), FailingRegistry): pass
        self.assertEqual([sys.monitoring.get_tool(i) for i in range(6)], previous)
        self.assertIs(generators[0]._sample, original)
        self.assertIsNone(FailingRegistry.backend)

    def test_threaded_api_returns_remain_original_and_each_are_captured_once(self):
        import concurrent.futures
        program, _, _ = make()
        with tempfile.TemporaryDirectory() as directory:
            with NativeSearchObserver(program, budget(), Path(directory), Registry) as observer:
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    results=list(pool.map(lambda n: Registry.get('cpu-tool').function({'n':n}, {}), range(4)))
                observer.verify()
            self.assertEqual(len(results),4)
            self.assertEqual(observer.counts['toolCalls'],4)
            self.assertTrue(all(call['status']=='completed' for call in observer.calls))
            self.assertEqual(len(Registry.effects),4)

    def test_cache_hits_count_api_requests_without_redispatch(self):
        class CachedRegistry(Registry):
            cache={}
            @classmethod
            def get(cls,key):
                def request(inputs,config):
                    if cls.backend: cls.backend(key,inputs,config)
                    identity=json.dumps(inputs,sort_keys=True)
                    if identity not in cls.cache:
                        cls.effects.append(key)
                        cls.cache[identity]=NResult()
                    return cls.cache[identity]
                return N(function=request)
        CachedRegistry.backend=None;CachedRegistry.effects=[]
        program, _, _ = make()
        with tempfile.TemporaryDirectory() as directory:
            with NativeSearchObserver(program,budget(),Path(directory),CachedRegistry) as observer:
                first=CachedRegistry.get('cpu-tool').function({'sequence':'AAAA'}, {})
                second=CachedRegistry.get('cpu-tool').function({'sequence':'AAAA'}, {})
                observer.verify()
            self.assertIs(first,second)
            self.assertEqual(len(CachedRegistry.effects),1)
            self.assertEqual(observer.counts['toolCalls'],2)
            self.assertEqual(observer.calls[0]['outputHash'],observer.calls[1]['outputHash'])

    def test_callable_global_settings_defaults_and_unresolved_dependencies_are_honest(self):
        from autofold_worker.native_search import _function
        global AUDIT_GLOBAL_COEFFICIENT
        old=AUDIT_GLOBAL_COEFFICIENT;defaults=configurable_objective.__defaults__
        try:
            first=_function(configurable_objective)
            AUDIT_GLOBAL_COEFFICIENT=2
            second=_function(configurable_objective)
            self.assertNotEqual(first,second)
            self.assertEqual(first['sourceHash'],second['sourceHash'])
            configurable_objective.__defaults__=(3,)
            self.assertNotEqual(second,_function(configurable_objective))
            unresolved=_function(external_module_objective)
            self.assertEqual(unresolved['comparability'],'unresolved')
            self.assertIn('json:module',unresolved['unresolvedDependencies'])
        finally:
            AUDIT_GLOBAL_COEFFICIENT=old
            configurable_objective.__defaults__=defaults
