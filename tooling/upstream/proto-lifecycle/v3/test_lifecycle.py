"""Offline CPU parity checks for the concrete scoped Proto lifecycle patch."""
from __future__ import annotations

import contextvars
import os
import threading
import time
import unittest
from contextlib import nullcontext
from unittest.mock import patch

import numpy as np
from pydantic import Field
from proto_language.core import Construct, PortfolioLane, PortfolioProgram, Program, SamplingObserver, Segment, Sequence, sampling_observation_scope
from proto_language.constraint import ConstraintRegistry
from proto_language.generator import RandomNucleotideGenerator, RandomNucleotideGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from proto_tools import ToolRegistry
from proto_tools.utils import BaseConfig, ConfigField
from proto_tools.utils.execution_observer import ExecutionCancelled, ExecutionControl, ObservationPublicationError, RequestObserver, request_observation_scope
from proto_tools.utils.tool_cache import ToolCache, _program_tool_cache
from proto_tools.utils.tool_io import BaseToolInput, BaseToolOutput
import proto_tools.tools.tool_registry as registry_module

COUNTS = {"preprocess": 0, "execute": 0}


class Inputs(BaseToolInput):
    text: str = Field(title="Text", description="CPU test input")


class Config(BaseConfig):
    tag: str = ConfigField(default="cpu", title="Tag", description="CPU test setting")

    def preprocess(self, inputs):
        COUNTS["preprocess"] += 1
        return inputs, self


class FixtureOutput(BaseToolOutput):
    @classmethod
    def output_format_options(cls):
        return ["json"]

    @classmethod
    def output_format_default(cls):
        return "json"

    def _export_output(self, *args, **kwargs):
        raise AssertionError("Export is outside this CPU fixture")


class Output(FixtureOutput):
    value: str = Field(title="Value", description="CPU test result")


@ToolRegistry.register(key="cohesive-fixture-value", label="CPU fixture", category="fixture", description="Local CPU lifecycle regression fixture", input_class=Inputs, config_class=Config, output_class=Output, cacheable=True)
def value_tool(inputs, config, instance=None):
    COUNTS["execute"] += 1
    return Output(value=inputs.text + config.tag)


class BatchInputs(BaseToolInput):
    values: list[str] = Field(title="Values", description="CPU test batch")


class BatchOutput(FixtureOutput):
    values: list[str] = Field(title="Values", description="CPU result batch")


@ToolRegistry.register(key="cohesive-fixture-batch", label="CPU batch", category="fixture", description="Local CPU lifecycle regression fixture", input_class=BatchInputs, config_class=Config, output_class=BatchOutput, cacheable=True, iterable_input_fields=["values"], iterable_output_field="values")
def batch_tool(inputs, config, instance=None):
    COUNTS["execute"] += 1
    return BatchOutput(values=[value.upper() for value in inputs.values])


@ToolRegistry.register(key="cohesive-fixture-failure", label="CPU failure", category="fixture", description="Local CPU lifecycle regression fixture", input_class=Inputs, config_class=Config, output_class=Output)
def failing_tool(inputs, config, instance=None):
    COUNTS["execute"] += 1
    raise ValueError("known CPU failure")


@ToolRegistry.register(key="cohesive-fixture-retry", label="CPU retry", category="fixture", description="Local CPU lifecycle regression fixture", input_class=Inputs, config_class=Config, output_class=Output)
def retry_tool(inputs, config, instance=None):
    COUNTS["execute"] += 1
    if COUNTS["execute"] == 1:
        raise ConnectionError("first CPU attempt")
    return Output(value="retry-success")


class Requests(RequestObserver):
    def __init__(self, control=None, reject=False):
        self.records = []
        self.control = control
        self.reject = reject

    def before_request(self, event):
        if self.reject:
            raise ExecutionCancelled("before-request rejection")
        token = object()
        self.records.append(("start", event, token))
        return token

    def request_completed(self, event, token):
        self.records.append(("completed", event, token))

    def request_failed(self, event, token, error):
        self.records.append(("failed", event, token, error))


class Samples(SamplingObserver):
    def __init__(self, reject=False):
        self.records = []
        self.reject = reject

    def before_sample(self, event):
        if self.reject:
            raise ExecutionCancelled("before-sample rejection")
        token = object()
        self.records.append(("start", event, token))
        return token

    def sample_completed(self, event, token):
        self.records.append(("completed", event, token))

    def sample_failed(self, event, token, error):
        self.records.append(("failed", event, token, error))


def make_program(seed=17):
    segment = Segment(sequence="ATGCATGCATGC", sequence_type="dna", label="design")
    construct = Construct([segment], label="construct")
    generator = RandomNucleotideGenerator(RandomNucleotideGeneratorConfig())
    generator.assign(segment)
    constraint = ConstraintRegistry.create(key="gc-content", segments=[segment], config_dict={"min_gc": 0, "max_gc": 100})
    optimizer = RejectionSamplingOptimizer(constructs=[construct], generators=[generator], constraints=[constraint], config=RejectionSamplingOptimizerConfig(num_samples=3, num_results=2))
    return Program([optimizer], num_results=2, seed=seed, compute=nullcontext())


def program_output(program):
    return {"sequences": [sequence.sequence for construct in program.constructs for sequence in construct.joined_sequences], "scores": program.energy_scores}


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        COUNTS.update(preprocess=0, execute=0)
        self.cache_token = _program_tool_cache.set(None)
        self.assertFalse(ToolRegistry.dispatch_backend_configured())

    def tearDown(self):
        ToolRegistry.clear_dispatch_backend()
        _program_tool_cache.reset(self.cache_token)

    def test_construction_scope_remains_inspectable_until_an_actual_program_entry(self):
        program = make_program()
        control = ExecutionControl()
        with sampling_observation_scope(Samples(), control, require_scoped_calls=True, allow_program_execution=False):
            self.assertFalse(control.cancelled)
            self.assertEqual(len(program.constructs), 1)
            self.assertFalse(control.cancelled)
            with self.assertRaisesRegex(ExecutionCancelled, "forbidden during construction"):
                program.run()
            self.assertTrue(control.cancelled)

    def test_construction_program_run_and_run_stage_deny_before_state_or_optimizer_mutation(self):
        for entry in (lambda p: p.run(), lambda p: p.run_stage(0)):
            program = make_program()
            program.current_stage = 7
            sentinel = [{"original": True}]
            program._stage_results = sentinel
            initial = program.optimizers[0]._initial_state
            control = ExecutionControl()
            with patch.object(program.optimizers[0], "run") as body, sampling_observation_scope(Samples(), control, require_scoped_calls=True, allow_program_execution=False):
                with self.assertRaises(ExecutionCancelled):
                    entry(program)
                body.assert_not_called()
            self.assertEqual(program.current_stage, 7)
            self.assertIs(program._stage_results, sentinel)
            self.assertIs(program.optimizers[0]._initial_state, initial)

    def test_construction_portfolio_deny_does_not_reset_lane_failures_or_start_cpu_lane(self):
        first, second = make_program(), make_program(19)
        portfolio = PortfolioProgram([first, second])
        sentinel = [{"prior": "known"}]
        portfolio.lane_failures = sentinel
        with sampling_observation_scope(Samples(), ExecutionControl(), require_scoped_calls=True, allow_program_execution=False), patch.object(first, "run") as body:
            with self.assertRaises(ExecutionCancelled):
                portfolio.run()
            body.assert_not_called()
        self.assertIs(portfolio.lane_failures, sentinel)

    def test_native_portfolio_has_one_immutable_inspection_and_execution_lane_authority(self):
        first, second, third = make_program(7), make_program(17), make_program(19)
        portfolio = PortfolioProgram([PortfolioLane(first, "first"), PortfolioLane(second, "second")])
        with self.assertRaises(TypeError):
            portfolio.programs[0] = third
        with self.assertRaises(AttributeError):
            portfolio.programs = [third, second]
        with self.assertRaises(AttributeError):
            portfolio.lanes = [PortfolioLane(third)]
        with self.assertRaises(TypeError):
            portfolio.lanes[0] = PortfolioLane(third)
        self.assertIs(portfolio.programs[0], first)
        self.assertIs(portfolio.lanes[0].program, first)
        with patch.object(first, "run") as a, patch.object(second, "run") as b, patch.object(third, "run") as c:
            portfolio.run()
            a.assert_called_once(); b.assert_called_once(); c.assert_not_called()

    def test_mutated_shared_native_state_is_rejected_before_inspection_or_execution(self):
        for component in ("construct", "segment", "generator"):
            first, second = make_program(7), make_program(17)
            portfolio = PortfolioProgram([first, second])
            if component == "construct":
                second.optimizers[0].constructs[0] = first.constructs[0]
            elif component == "segment":
                second.constructs[0].segments = (first.constructs[0].segments[0],)
            else:
                second.optimizers[0].generators[0] = first.optimizers[0].generators[0]
            with self.assertRaisesRegex(ValueError, "share scientific state"):
                _ = portfolio.constructs
            with patch.object(first, "run") as a, patch.object(second, "run") as b:
                with self.assertRaisesRegex(ValueError, "share scientific state"):
                    portfolio.run()
                a.assert_not_called(); b.assert_not_called()

    def test_cancelled_single_cpu_program_cannot_reset_or_start_an_optimizer(self):
        for entry in (lambda p: p.run(), lambda p: p.run_stage(0)):
            program = make_program()
            program.current_stage = 9
            control = ExecutionControl()
            with sampling_observation_scope(Samples(), control, require_scoped_calls=True), patch.object(program.optimizers[0], "run") as body:
                control.cancel()
                with self.assertRaises(ExecutionCancelled):
                    entry(program)
                body.assert_not_called()
            self.assertEqual(program.current_stage, 9)

    def test_request_only_cancellation_prevents_single_cpu_program_body(self):
        program = make_program()
        control = ExecutionControl()
        with request_observation_scope(Requests(), control, require_scoped_calls=True), patch.object(program.optimizers[0], "run") as body:
            control.cancel()
            with self.assertRaises(ExecutionCancelled):
                program.run()
            body.assert_not_called()

    def test_request_only_escaped_and_expired_program_calls_deny_before_cpu_body(self):
        program = make_program()
        failures = []
        def escaped():
            try:
                program.run_stage(0)
            except BaseException as error:
                failures.append(error)
        with patch.object(program.optimizers[0], "run") as body:
            with request_observation_scope(Requests(), ExecutionControl(), require_scoped_calls=True):
                saved = contextvars.copy_context()
                thread = threading.Thread(target=escaped)
                thread.start(); thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertIsInstance(failures[0], ExecutionCancelled)
            with self.assertRaises(ExecutionCancelled):
                saved.run(program.run)
            body.assert_not_called()

    def test_managed_program_entries_reject_escaped_threads_and_expired_copies_before_cpu_body(self):
        program = make_program()
        failures = []
        def escaped():
            try:
                program.run()
            except BaseException as error:
                failures.append(error)
        with patch.object(program.optimizers[0], "run") as body:
            with sampling_observation_scope(Samples(), ExecutionControl(), require_scoped_calls=True):
                saved = contextvars.copy_context()
                thread = threading.Thread(target=escaped)
                thread.start(); thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertIsInstance(failures[0], ExecutionCancelled)
            with self.assertRaises(ExecutionCancelled):
                saved.run(program.run)
            body.assert_not_called()

    def test_default_scoped_program_retains_unobserved_native_results_and_settings(self):
        plain, scoped = make_program(17), make_program(17)
        plain.run()
        with sampling_observation_scope(Samples()):
            scoped.run()
        self.assertEqual(program_output(plain), program_output(scoped))
        self.assertEqual([o.config.model_dump() for o in plain.optimizers], [o.config.model_dump() for o in scoped.optimizers])

    def test_retained_hosted_fence_denies_raw_threads_in_scope_gaps_and_after_pure_publication(self):
        import subprocess, sys
        from pathlib import Path
        root = Path(__file__).resolve().parents[2]
        child = r'''
import contextvars, json, os, runpy, sys, threading
from pathlib import Path
values=runpy.run_path(sys.argv[1],run_name="cohesive_retained_fixture")
globals().update({name:values[name] for name in ("make_program","Requests","Samples","Inputs","value_tool","COUNTS")})
from proto_language.core import sampling_observation_scope
from proto_tools.utils.execution_observer import request_observation_scope, ExecutionControl, ExecutionCancelled
program=make_program();generator=program.optimizers[0].generators[0]
control=ExecutionControl(); failures=[]
def delayed(gate):
    gate.wait(5)
    for effect in (program.run, generator.sample, lambda:value_tool(Inputs(text="escaped"))):
        try: effect()
        except ExecutionCancelled: failures.append("denied")
        else: raise AssertionError("Unobserved effect escaped retained fence")
gate=threading.Event();thread=threading.Thread(target=delayed,args=(gate,));thread.start()
with request_observation_scope(Requests(),control,require_scoped_calls=True,keep_unobserved_closed=True), sampling_observation_scope(Samples(),control,require_scoped_calls=True,allow_program_execution=False,keep_unobserved_closed=True):
    assert not control.cancelled
    assert len(program.constructs)==1
gate.set();thread.join(5);assert not thread.is_alive();assert len(failures)==3;assert COUNTS["execute"]==0
assert program.current_stage==0
# A next explicitly managed scope remains usable without reopening raw calls.
gate=threading.Event();thread=threading.Thread(target=delayed,args=(gate,));thread.start()
with request_observation_scope(Requests(),control,require_scoped_calls=True,keep_unobserved_closed=True), sampling_observation_scope(Samples(),control,require_scoped_calls=True,keep_unobserved_closed=True):
    program.run();value_tool(Inputs(text="admitted"))
    pure=json.loads(json.dumps({"sequence":program.constructs[0].joined_sequences[0].sequence}))
# Model-facing scopes are now closed but the disposable process is still alive
# to publish pure data. The raw thread cannot fill that interval with effects.
Path(sys.argv[2]).write_text(json.dumps(pure));gate.set();thread.join(5)
assert not thread.is_alive();assert len(failures)==6;assert COUNTS["execute"]==1
print(json.dumps({"denied":len(failures),"registeredFixtureEffects":COUNTS["execute"]}),flush=True)
os._exit(0)
'''
        import tempfile, os
        with tempfile.TemporaryDirectory() as temporary:
            env = {**os.environ, "PYTHONPATH": str(root) + os.pathsep + str(root / "proto-tools"), "CUDA_VISIBLE_DEVICES":"", "HF_HUB_OFFLINE":"1", "TRANSFORMERS_OFFLINE":"1", "PYTHONDONTWRITEBYTECODE":"1"}
            result = subprocess.run([sys.executable,"-B","-c",child,str(Path(__file__).resolve()),str(Path(temporary)/"pure.json")],env=env,capture_output=True,text=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            import json
            self.assertEqual(json.loads(result.stdout.strip().splitlines()[-1]),{"denied":6,"registeredFixtureEffects":1})

    def test_managed_thread_escape_and_expired_context_fail_closed(self):
        observer = Requests()
        failures = []
        def escaped():
            try:
                value_tool(Inputs(text="escaped"))
            except BaseException as error:
                failures.append(error)
        with request_observation_scope(observer, require_scoped_calls=True):
            thread = threading.Thread(target=escaped)
            thread.start(); thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertIsInstance(failures[0], ExecutionCancelled)
            self.assertEqual(COUNTS["execute"], 0)
            saved = contextvars.copy_context()
            saved.run(value_tool, Inputs(text="copied"))
        with self.assertRaises(ExecutionCancelled):
            saved.run(value_tool, Inputs(text="expired"))
        self.assertEqual(COUNTS["execute"], 1)
        value_tool(Inputs(text="ordinary"))
        self.assertEqual(COUNTS["execute"], 2)

    def test_concurrent_requests_pair_tokens_and_origins(self):
        from concurrent.futures import ThreadPoolExecutor
        observer, barrier = Requests(), threading.Barrier(2)
        def backend(key, inputs, config):
            barrier.wait(5)
            return Output(value=inputs.text)
        ToolRegistry.configure_dispatch_backend(backend)
        with request_observation_scope(observer, require_scoped_calls=True), ThreadPoolExecutor(max_workers=2) as executor:
            contexts = [contextvars.copy_context(), contextvars.copy_context()]
            futures = [executor.submit(context.run, value_tool, Inputs(text=str(index))) for index, context in enumerate(contexts)]
            self.assertEqual([future.result(5).value for future in futures], ["0", "1"])
        starts = {record[1].request_id: record for record in observer.records if record[0] == "start"}
        ends = {record[1].request_id: record for record in observer.records if record[0] == "completed"}
        self.assertEqual(set(starts), set(ends))
        self.assertEqual(len(starts), 2)
        for identity, start in starts.items():
            self.assertIs(start[2], ends[identity][2])
            self.assertEqual(ends[identity][1].cache_origin, "external_dispatch_backend")
            self.assertEqual(ends[identity][1].result.value, start[1].inputs.text)

    def test_concurrent_sampling_and_escaped_scope(self):
        from concurrent.futures import ThreadPoolExecutor
        generators = [make_program(seed).optimizers[0].generators[0] for seed in (17, 19)]
        observer, barrier = Samples(), threading.Barrier(2)
        failures = []
        def escaped():
            try:
                generators[0].sample()
            except BaseException as error:
                failures.append(error)
        with sampling_observation_scope(observer, require_scoped_calls=True):
            thread = threading.Thread(target=escaped)
            thread.start(); thread.join(5)
            self.assertIsInstance(failures[0], ExecutionCancelled)
            with patch.object(generators[0], "_sample", side_effect=lambda: barrier.wait(5)), patch.object(generators[1], "_sample", side_effect=lambda: barrier.wait(5)), ThreadPoolExecutor(max_workers=2) as executor:
                contexts = [contextvars.copy_context(), contextvars.copy_context()]
                futures = [executor.submit(context.run, generator.sample) for context, generator in zip(contexts, generators)]
                for future in futures:
                    future.result(5)
            saved = contextvars.copy_context()
        starts = {record[1].sample_id: record for record in observer.records if record[0] == "start"}
        ends = {record[1].sample_id: record for record in observer.records if record[0] == "completed"}
        self.assertEqual(set(starts), set(ends))
        self.assertEqual({id(record[1].generator) for record in starts.values()}, {id(generator) for generator in generators})
        for identity, start in starts.items():
            self.assertIs(start[2], ends[identity][2])
        with self.assertRaises(ExecutionCancelled):
            saved.run(generators[0].sample)
        with patch.object(generators[0], "_sample") as sample:
            generators[0].sample()
            sample.assert_called_once()

    def test_actual_native_toolpool_threads_propagate_authority(self):
        from proto_tools.utils.tool_pool import ToolPool
        class FanoutConfig(Config):
            device: str = ConfigField(default="cpu", title="Device", description="CPU device")
            @property
            def cpus_per_instance(self):
                return 1
        # Exercise the real native thread partition path; raw partition work is
        # included in the parent registered request, and nested requests inherit.
        pool = ToolPool(gpus=0, cpus=2)
        pool._gpu_devices = []
        observer, thread_ids = Requests(), []
        def raw(inputs, config, instance=None):
            thread_ids.append(threading.get_ident())
            return BatchOutput(values=[value_tool(Inputs(text=value)).value for value in inputs.values])
        with request_observation_scope(observer, require_scoped_calls=True), patch("proto_tools.utils.tool_pool.ToolInstance.get"):
            result = pool._parallel_dispatch("cohesive-fixture-batch", raw, BatchInputs(values=["a", "b", "c", "d"]), FanoutConfig())
        self.assertEqual(result.values, ["acpu", "bcpu", "ccpu", "dcpu"])
        self.assertTrue(all(identity != threading.get_ident() for identity in thread_ids))
        self.assertEqual(sum(record[0] == "start" for record in observer.records), 4)
        self.assertEqual(sum(record[0] == "completed" for record in observer.records), 4)

    def test_actual_native_mmseqs_threads_propagate_authority_without_network(self):
        from pathlib import Path
        from proto_tools.tools.sequence_alignment.mmseqs2 import homology_search
        observer = Requests()
        def offline_dispatch(*args):
            value_tool(Inputs(text="native-thread"))
            return {"success": False, "errors": ["intentional CPU fixture stop"]}
        with request_observation_scope(observer, require_scoped_calls=True), patch.object(homology_search, "_dispatch_remote", offline_dispatch):
            with self.assertRaisesRegex(RuntimeError, "intentional CPU fixture stop"):
                homology_search._remote_paired_group([], Path("unused-fixture-path"), None)
        self.assertEqual(sum(record[0] == "start" for record in observer.records), 2)
        self.assertEqual(sum(record[0] == "completed" for record in observer.records), 2)

    def test_cancel_before_retry_avoids_second_execution(self):
        control, observer = ExecutionControl(), Requests()
        def cancel_during_delay(_seconds):
            control.cancel()
        with request_observation_scope(observer, control), patch.object(registry_module.time, "sleep", cancel_during_delay), patch.dict(os.environ, {"PROTO_CAPTURE_ERRORS": "1"}):
            with self.assertRaises(ExecutionCancelled):
                retry_tool(Inputs(text="a"))
        self.assertEqual(COUNTS, {"preprocess": 1, "execute": 1})
        self.assertEqual([record[0] for record in observer.records], ["start", "failed"])

    def test_request_failure_callback_preserves_exact_native_error_and_scope(self):
        class BrokenFailureObserver(Requests):
            def request_failed(self, event, token, error):
                self.original = error
                raise RuntimeError("receipt publication failed")
        for original in (ValueError("native request failure"), ExecutionCancelled("native request cancellation")):
            cause = LookupError("original request cause")
            original.__cause__ = cause
            observer, control = BrokenFailureObserver(), ExecutionControl()
            def backend(*args):
                raise original
            ToolRegistry.configure_dispatch_backend(backend)
            with request_observation_scope(observer, control, require_scoped_calls=True):
                with self.assertRaises(type(original)) as raised:
                    value_tool(Inputs(text="a"))
            self.assertIs(raised.exception, original)
            self.assertIs(observer.original, original)
            self.assertIs(original.__cause__, cause)
            self.assertTrue(any("receipt publication failed" in note for note in original.__notes__))
            self.assertTrue(control.cancelled)
            ToolRegistry.clear_dispatch_backend()
            value_tool(Inputs(text="after-scope"))

    def test_sampling_failure_callback_preserves_exact_native_error_and_scope(self):
        class BrokenFailureObserver(Samples):
            def sample_failed(self, event, token, error):
                self.original = error
                raise RuntimeError("sample publication failed")
        generator = make_program().optimizers[0].generators[0]
        for original in (ValueError("native sample failure"), ExecutionCancelled("native sample cancellation")):
            cause = LookupError("original sample cause")
            original.__cause__ = cause
            observer, control = BrokenFailureObserver(), ExecutionControl()
            with patch.object(generator, "_sample", side_effect=original), sampling_observation_scope(observer, control, require_scoped_calls=True):
                with self.assertRaises(type(original)) as raised:
                    generator.sample()
            self.assertIs(raised.exception, original)
            self.assertIs(observer.original, original)
            self.assertIs(original.__cause__, cause)
            self.assertTrue(any("sample publication failed" in note for note in original.__notes__))
            self.assertTrue(control.cancelled)
            with patch.object(generator, "_sample") as work:
                generator.sample()
                work.assert_called_once()

    def test_managed_completed_request_publication_stops_sibling_lane(self):
        class BrokenCompletionObserver(Requests):
            def request_completed(self, event, token):
                self.output = event.result
                raise RuntimeError("completed receipt publication failed")
        first, second = make_program(), make_program(19)
        portfolio = PortfolioProgram([first, second])
        requests, control = BrokenCompletionObserver(), ExecutionControl()
        with sampling_observation_scope(Samples(), control, require_scoped_calls=True), request_observation_scope(requests, control, require_scoped_calls=True), patch.object(first, "run", side_effect=lambda: value_tool(Inputs(text="first"))), patch.object(second, "run") as sibling:
            with self.assertRaises(ObservationPublicationError) as raised:
                portfolio.run()
            sibling.assert_not_called()
        self.assertEqual(COUNTS["execute"], 1)
        self.assertEqual(requests.output.value, "firstcpu")
        self.assertIsInstance(raised.exception.__cause__, RuntimeError)
        self.assertTrue(control.cancelled)
        self.assertEqual(portfolio.lane_failures, [])

    def test_managed_completed_sample_publication_stops_sibling_lane(self):
        class BrokenCompletionObserver(Samples):
            def sample_completed(self, event, token):
                raise RuntimeError("completed sample publication failed")
        first, second = make_program(), make_program(19)
        portfolio = PortfolioProgram([first, second])
        generator = first.optimizers[0].generators[0]
        control = ExecutionControl()
        with sampling_observation_scope(BrokenCompletionObserver(), control, require_scoped_calls=True), request_observation_scope(Requests(), control, require_scoped_calls=True), patch.object(generator, "_sample") as work, patch.object(first, "run", side_effect=generator.sample), patch.object(second, "run") as sibling:
            with self.assertRaises(ObservationPublicationError) as raised:
                portfolio.run()
            work.assert_called_once()
            sibling.assert_not_called()
        self.assertIsInstance(raised.exception.__cause__, RuntimeError)
        self.assertTrue(control.cancelled)
        self.assertEqual(portfolio.lane_failures, [])

    def test_managed_failed_request_publication_prevents_sibling_lane_start(self):
        class BrokenFailureObserver(Requests):
            def request_failed(self, event, token, error):
                self.original = error
                raise RuntimeError("failed request receipt publication failed")
        first, second = make_program(), make_program(19)
        portfolio, observer, control = PortfolioProgram([first, second]), BrokenFailureObserver(), ExecutionControl()
        with sampling_observation_scope(Samples(), control, require_scoped_calls=True), request_observation_scope(observer, control, require_scoped_calls=True), patch.object(first, "run", side_effect=lambda: failing_tool(Inputs(text="first"))), patch.object(second, "run") as sibling:
            with self.assertRaises(ObservationPublicationError):
                portfolio.run()
            sibling.assert_not_called()
        self.assertEqual(COUNTS["execute"], 1)
        self.assertEqual(portfolio.lane_failures[0]["errorType"], "ValueError")
        self.assertEqual(str(observer.original), "known CPU failure")
        self.assertTrue(control.cancelled)

    def test_managed_failed_sample_publication_prevents_sibling_lane_start(self):
        class BrokenFailureObserver(Samples):
            def sample_failed(self, event, token, error):
                self.original = error
                raise RuntimeError("failed sample receipt publication failed")
        first, second = make_program(), make_program(19)
        portfolio, observer, control = PortfolioProgram([first, second]), BrokenFailureObserver(), ExecutionControl()
        generator = first.optimizers[0].generators[0]
        with sampling_observation_scope(observer, control, require_scoped_calls=True), request_observation_scope(Requests(), control, require_scoped_calls=True), patch.object(generator, "_sample", side_effect=ValueError("known sample failure")), patch.object(first, "run", side_effect=generator.sample), patch.object(second, "run") as sibling:
            with self.assertRaises(ExecutionCancelled):
                portfolio.run()
            sibling.assert_not_called()
        self.assertEqual(portfolio.lane_failures[0]["errorType"], "ValueError")
        self.assertTrue(control.cancelled)

    def test_recorded_scientific_failure_still_advances_managed_portfolio(self):
        first, second = make_program(), make_program(19)
        portfolio, observer, control = PortfolioProgram([first, second]), Requests(), ExecutionControl()
        with sampling_observation_scope(Samples(), control, require_scoped_calls=True), request_observation_scope(observer, control, require_scoped_calls=True), patch.object(first, "run", side_effect=lambda: failing_tool(Inputs(text="first"))), patch.object(second, "run", side_effect=lambda: value_tool(Inputs(text="second"))) as sibling:
            portfolio.run()
            sibling.assert_called_once()
        self.assertEqual(COUNTS["execute"], 2)
        self.assertFalse(control.cancelled)
        self.assertEqual([record[0] for record in observer.records], ["start", "failed", "start", "completed"])
        self.assertEqual(portfolio.lane_failures[0]["errorType"], "ValueError")

    def test_cancelled_managed_portfolio_never_starts_first_fixed_lane(self):
        first, second = make_program(), make_program(19)
        portfolio, control = PortfolioProgram([first, second]), ExecutionControl()
        with sampling_observation_scope(Samples(), control, require_scoped_calls=True), request_observation_scope(Requests(), control, require_scoped_calls=True), patch.object(first, "run") as initial, patch.object(second, "run") as sibling:
            control.cancel()
            with self.assertRaises(ExecutionCancelled):
                portfolio.run()
            initial.assert_not_called()
            sibling.assert_not_called()

    def test_malformed_native_notes_cannot_mask_request_error(self):
        original, publication = ValueError("native"), RuntimeError("publication")
        original.__notes__ = "malformed native notes"
        class BrokenObserver(Requests):
            def request_failed(self, event, token, error):
                raise publication
        def backend(*args):
            raise original
        ToolRegistry.configure_dispatch_backend(backend)
        with request_observation_scope(BrokenObserver()):
            with self.assertRaises(ValueError) as raised:
                value_tool(Inputs(text="a"))
        self.assertIs(raised.exception, original)
        self.assertIs(original.proto_observation_callback_failure, publication)

    def test_malformed_native_notes_cannot_mask_sampling_error(self):
        original, publication = ValueError("native"), RuntimeError("publication")
        original.__notes__ = "malformed native notes"
        class BrokenObserver(Samples):
            def sample_failed(self, event, token, error):
                raise publication
        generator = make_program().optimizers[0].generators[0]
        with sampling_observation_scope(BrokenObserver()), patch.object(generator, "_sample", side_effect=original):
            with self.assertRaises(ValueError) as raised:
                generator.sample()
        self.assertIs(raised.exception, original)
        self.assertIs(original.proto_observation_callback_failure, publication)

    def test_registry_preprocess_dispatch_and_whole_cache_once(self):
        observer = Requests()
        cache_token = _program_tool_cache.set(ToolCache())
        try:
            with request_observation_scope(observer):
                first = value_tool(Inputs(text="a"))
                second = value_tool(Inputs(text="a"))
            self.assertIs(first, second)
            self.assertEqual(COUNTS, {"preprocess": 1, "execute": 1})
            ends = [record[1] for record in observer.records if record[0] == "completed"]
            self.assertEqual([event.cache_origin for event in ends], ["cache_miss", "cache_hit"])
            self.assertIs(ends[0].result, first)
            self.assertEqual(len({event.request_id for event in ends}), 2)
            self.assertIs(observer.records[0][2], observer.records[1][2])
        finally:
            _program_tool_cache.reset(cache_token)

    def test_iterable_dedup_partial_and_full_cache(self):
        observer = Requests()
        cache_token = _program_tool_cache.set(ToolCache())
        try:
            with request_observation_scope(observer):
                self.assertEqual(batch_tool(BatchInputs(values=["a", "a"])).values, ["A", "A"])
                self.assertEqual(batch_tool(BatchInputs(values=["a", "b"])).values, ["A", "B"])
                self.assertEqual(batch_tool(BatchInputs(values=["b", "a"])).values, ["B", "A"])
            self.assertEqual(COUNTS, {"preprocess": 2, "execute": 2})
            self.assertEqual([record[1].cache_origin for record in observer.records if record[0] == "completed"], ["cache_miss", "cache_partial", "cache_hit"])
        finally:
            _program_tool_cache.reset(cache_token)

    def test_existing_backend_override_and_fallthrough_preserved(self):
        observer = Requests()
        calls = []
        ToolRegistry.configure_dispatch_backend(lambda key, inputs, config: calls.append(key) or Output(value="external-fixture"))
        with request_observation_scope(observer):
            self.assertEqual(value_tool(Inputs(text="a")).value, "external-fixture")
        self.assertEqual(COUNTS, {"preprocess": 0, "execute": 0})
        self.assertEqual(calls, ["cohesive-fixture-value"])
        self.assertTrue(ToolRegistry.dispatch_backend_configured())
        self.assertEqual(observer.records[-1][1].cache_origin, "external_dispatch_backend")
        ToolRegistry.configure_dispatch_backend(lambda key, inputs, config: None)
        observer = Requests()
        with request_observation_scope(observer):
            self.assertEqual(value_tool(Inputs(text="b")).value, "bcpu")
        self.assertEqual(COUNTS, {"preprocess": 1, "execute": 1})
        self.assertEqual(observer.records[-1][1].cache_origin, "cache_disabled")

    def test_failure_raise_and_capture_keep_terminal_identity(self):
        for capture in ("0", "1"):
            observer = Requests()
            with patch.dict(os.environ, {"PROTO_CAPTURE_ERRORS": capture}), request_observation_scope(observer):
                if capture == "0":
                    with self.assertRaisesRegex(ValueError, "known CPU failure"):
                        failing_tool(Inputs(text="a"))
                    self.assertEqual(observer.records[-1][0], "failed")
                else:
                    result = failing_tool(Inputs(text="a"))
                    self.assertFalse(result.success)
                    self.assertEqual(observer.records[-1][0], "completed")
                    self.assertIs(observer.records[-1][1].result, result)
            self.assertEqual(observer.records[0][1].request_id, observer.records[-1][1].request_id)
            self.assertIs(observer.records[0][2], observer.records[-1][2])

    def test_retries_one_public_lifecycle(self):
        observer = Requests()
        with patch.object(registry_module, "RETRY_DELAY", 0), request_observation_scope(observer):
            self.assertEqual(retry_tool(Inputs(text="a")).value, "retry-success")
        self.assertEqual(COUNTS, {"preprocess": 1, "execute": 2})
        self.assertEqual([record[0] for record in observer.records], ["start", "completed"])

    def test_cancel_rejects_effect_and_capture_cannot_absorb_it(self):
        observer = Requests(reject=True)
        with patch.dict(os.environ, {"PROTO_CAPTURE_ERRORS": "1"}), request_observation_scope(observer):
            with self.assertRaises(ExecutionCancelled):
                value_tool(Inputs(text="a"))
        self.assertEqual(COUNTS, {"preprocess": 0, "execute": 0})
        self.assertEqual(observer.records, [])
        # Scope was restored, not leaked to the next ordinary request.
        self.assertEqual(value_tool(Inputs(text="a")).value, "acpu")

    def test_cancel_between_preprocess_and_dispatch(self):
        observer, control = Requests(), ExecutionControl()
        original = Config.preprocess
        def cancel_after_preprocess(config, inputs):
            result = original(config, inputs)
            control.cancel()
            return result
        with patch.object(Config, "preprocess", cancel_after_preprocess), request_observation_scope(observer, control):
            with self.assertRaises(ExecutionCancelled):
                value_tool(Inputs(text="a"))
        self.assertEqual(COUNTS, {"preprocess": 1, "execute": 0})
        self.assertEqual([record[0] for record in observer.records], ["start", "failed"])

    def test_expired_deadline_prevents_scope_admission(self):
        with self.assertRaises(ExecutionCancelled), request_observation_scope(Requests(), ExecutionControl(time.monotonic() - 1)):
            value_tool(Inputs(text="a"))
        self.assertEqual(COUNTS["execute"], 0)

    def test_nested_requests_link_distinct_identities(self):
        observer = Requests()
        def backend(key, inputs, config):
            if key == "cohesive-fixture-value":
                return Output(value=batch_tool(BatchInputs(values=[inputs.text])).values[0])
            return None
        ToolRegistry.configure_dispatch_backend(backend)
        with request_observation_scope(observer):
            self.assertEqual(value_tool(Inputs(text="a")).value, "A")
        starts = [record[1] for record in observer.records if record[0] == "start"]
        self.assertEqual(len(starts), 2)
        self.assertEqual(starts[1].parent_request_id, starts[0].request_id)
        self.assertNotEqual(starts[1].request_id, starts[0].request_id)

    def test_context_isolation_and_scope_collision_fail_closed(self):
        first, second = Requests(), Requests()
        with request_observation_scope(first):
            with self.assertRaises(RuntimeError), request_observation_scope(second):
                pass
            contextvars.Context().run(value_tool, Inputs(text="separate"))
            value_tool(Inputs(text="owned"))
        self.assertEqual(len(first.records), 2)
        self.assertEqual(first.records[0][1].inputs.text, "owned")
        self.assertEqual(second.records, [])

    def test_sampling_tied_segments_and_cleanup_parity(self):
        program = make_program()
        generator = program.optimizers[0].generators[0]
        first = generator.segment
        tied = Segment(sequence=first.original_sequence.sequence, sequence_type="dna", label="tied")
        generator.assign([first, tied])
        samples = Samples()
        def sample():
            first.proposal_sequences = [Sequence("AAAA", sequence_type="dna", logits=np.ones((4, 4)))]
        with patch.object(generator, "_sample", sample), sampling_observation_scope(samples):
            generator.sample()
        self.assertEqual([record[0] for record in samples.records], ["start", "completed"])
        self.assertIs(samples.records[0][1].generator, generator)
        self.assertIs(samples.records[0][2], samples.records[1][2])
        self.assertEqual(first.proposal_sequences[0].sequence, tied.proposal_sequences[0].sequence)
        self.assertIsNot(first.proposal_sequences[0], tied.proposal_sequences[0])
        self.assertIsNone(first.proposal_sequences[0].logits)
        self.assertIsNone(tied.proposal_sequences[0].logits)

    def test_sampling_rejection_failure_and_restore(self):
        generator = make_program().optimizers[0].generators[0]
        observer = Samples(reject=True)
        with patch.object(generator, "_sample") as sample, sampling_observation_scope(observer):
            with self.assertRaises(ExecutionCancelled):
                generator.sample()
            sample.assert_not_called()
        observer = Samples()
        with patch.object(generator, "_sample", side_effect=ValueError("sample failure")), sampling_observation_scope(observer):
            with self.assertRaisesRegex(ValueError, "sample failure"):
                generator.sample()
        self.assertEqual([record[0] for record in observer.records], ["start", "failed"])
        with patch.object(generator, "_sample") as sample:
            generator.sample()
            sample.assert_called_once()
        self.assertEqual(len(observer.records), 2)

    def test_real_optimizer_settings_seed_and_results_unchanged(self):
        baseline, observed = make_program(), make_program()
        settings = observed.optimizers[0].config.model_dump()
        baseline.run()
        samples, requests = Samples(), Requests()
        control = ExecutionControl(time.monotonic() + 60)
        with sampling_observation_scope(samples, control), request_observation_scope(requests, control):
            observed.run()
        self.assertEqual(program_output(baseline), program_output(observed))
        self.assertEqual(observed.optimizers[0].config.model_dump(), settings)
        self.assertTrue(samples.records)
        self.assertEqual(sum(record[0] == "start" for record in samples.records), sum(record[0] == "completed" for record in samples.records))

    def test_portfolio_native_parity_serial_failures_and_independence(self):
        first, second = make_program(17), make_program(19)
        baseline_first, baseline_second = make_program(17), make_program(19)
        baseline_first.run(); baseline_second.run()
        portfolio = PortfolioProgram([PortfolioLane(first, "first"), second])
        portfolio.run()
        self.assertEqual(program_output(first), program_output(baseline_first))
        self.assertEqual(program_output(second), program_output(baseline_second))
        self.assertEqual(portfolio.constructs, first.constructs + second.constructs)
        self.assertEqual(portfolio.lane_failures, [])
        with self.assertRaisesRegex(ValueError, "share scientific state"):
            PortfolioProgram([first, first])
        with patch.object(first, "run", side_effect=ValueError("bad lane")):
            portfolio.run()
        self.assertEqual(portfolio.lane_failures[0]["errorType"], "ValueError")
        with patch.object(first, "run", side_effect=ValueError("bad1")), patch.object(second, "run", side_effect=ValueError("bad2")):
            with self.assertRaisesRegex(RuntimeError, "Every portfolio lane failed"):
                portfolio.run()

    def test_portfolio_cancellation_does_not_run_next_lane(self):
        first, second = make_program(), make_program(19)
        portfolio = PortfolioProgram([first, second])
        with patch.object(first, "run", side_effect=ExecutionCancelled("cancel")), patch.object(second, "run") as next_lane:
            with self.assertRaises(ExecutionCancelled):
                portfolio.run()
            next_lane.assert_not_called()
        self.assertEqual(portfolio.lane_failures, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
