"""Native scientific search admission, observation and explicit final-output selection.

This is an outer resource/evidence boundary. Proto owns optimizer algorithms,
constraint semantics and mutable scientific state. Legacy bundles never enter it.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import math
import random
import functools
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from .protocol import ProtocolError

class NativeExecutionStopped(BaseException):
    """Fresh authority denial/publication loss cannot become a scientific retry."""


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def safe(value: Any) -> Any:
    if isinstance(value, random.Random):
        return {"rngState": safe(value.getstate())}
    if hasattr(value, "model_dump"):
        return safe(value.model_dump(mode="json"))
    if hasattr(value, "tolist"):
        return safe(value.tolist())
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(k): safe(v) for k, v in value.items()}
    if isinstance(value, (tuple, list, set, frozenset)):
        items = [safe(v) for v in value]
        return sorted(items) if isinstance(value, (set, frozenset)) else items
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if value is None or isinstance(value, (str, float, int, bool)):
        return value
    raise ProtocolError(f"Native state contains an unsupported value: {type(value).__name__}")


@dataclass(frozen=True)
class NativeOutput:
    """Explicit output region. None segment means one concatenated Construct.

    This never silently interprets concatenated segments as separate chains.
    The current independent evaluator admits canonical protein sequences only.
    """
    construct: str
    segment: str | None = None
    lane: int = 0

    def __post_init__(self):
        if not self.construct or self.segment == "" or type(self.lane) is not int or self.lane < 0:
            raise ValueError("Native output requires a construct label and nonnegative lane")


@dataclass(frozen=True)
class NativeSearch:
    """Explicit search-work ceilings, independent of the final submission size.

    proposals counts proposed sequences across generator invocations (the maximum
    aligned pool size for tied segments). sampling calls counts invocations, not
    optimizer steps. Tool calls counts registered API requests, including cache
    lookups; it is not a claim of physical inference count or GPU utilization.
    Wall time includes scoring/conditioning/setup; the worker's aggregate budget
    also covers the separate frozen evaluation phase.
    """
    maximum_candidates: int
    maximum_proposals: int
    maximum_sampling_calls: int
    maximum_tool_calls: int
    maximum_wall_seconds: int
    outputs: tuple[NativeOutput, ...]
    allowed_tools: tuple[str, ...] = ()

    def __post_init__(self):
        for key in ("maximum_candidates", "maximum_proposals", "maximum_sampling_calls", "maximum_tool_calls", "maximum_wall_seconds"):
            if type(getattr(self, key)) is not int or getattr(self, key) <= 0:
                raise ValueError(f"{key} must be a positive integer")
        if not self.outputs or len(set(self.outputs)) != len(self.outputs) or any(not isinstance(o, NativeOutput) for o in self.outputs):
            raise ValueError("Native search requires unique explicit NativeOutput selections")
        if len(set(self.allowed_tools)) != len(self.allowed_tools) or any(not isinstance(k, str) or not k for k in self.allowed_tools):
            raise ValueError("allowed_tools must be unique native tool keys")

    def plan(self):
        return {"maximumCandidates": self.maximum_candidates, "maximumProposals": self.maximum_proposals,
                "maximumSamplingCalls": self.maximum_sampling_calls, "maximumToolCalls": self.maximum_tool_calls,
                "maximumWallSeconds": self.maximum_wall_seconds,
                "outputs": [asdict(o) for o in self.outputs], "allowedTools": list(self.allowed_tools)}


@dataclass(frozen=True)
class NativeFixedControl:
    """An explicit, bounded native control with no sampling or tool requests."""
    maximum_wall_seconds: int
    outputs: tuple[NativeOutput, ...]

    def __post_init__(self):
        if type(self.maximum_wall_seconds) is not int or self.maximum_wall_seconds <= 0:
            raise ValueError("maximum_wall_seconds must be a positive integer")
        if not self.outputs or len(set(self.outputs)) != len(self.outputs) or any(not isinstance(o, NativeOutput) for o in self.outputs):
            raise ValueError("Native fixed control requires unique explicit NativeOutput selections")

    def plan(self):
        return {"maximumWallSeconds": self.maximum_wall_seconds, "outputs": [asdict(o) for o in self.outputs]}

    def observer_budget(self, maximum_candidates):
        # Zero-work authority is enforced by the observer before either body.
        return NativeSearch(maximum_candidates, 1, 1, 1, self.maximum_wall_seconds, self.outputs)


def lanes(program):
    from proto_language import core
    Portfolio = getattr(core, "PortfolioProgram", None)
    if Portfolio is not None and isinstance(program, Portfolio):
        return program.programs
    if type(program).__module__ == "autofold_worker.compatibility.proto_portfolio_v1":
        return program.programs
    return [program]


def _function(fn, _seen=None):
    """A bounded comparison descriptor, distinct from original program identity."""
    if fn is None:
        return None
    seen = set() if _seen is None else _seen
    if id(fn) in seen:
        return {"comparability": "unresolved", "reason": "recursive callable dependency"}
    seen = seen | {id(fn)}
    if isinstance(fn, functools.partial):
        return {"partial": _function(fn.func, seen), "args": safe(fn.args), "kwargs": safe(fn.keywords)}
    try:
        source = inspect.getsource(fn)
    except (OSError, TypeError):
        raise ProtocolError("Native callable must expose source for admission")
    captured, globals_, unresolved = {}, {}, []
    def capture(name, value, target):
        try:
            target[name] = _function(value, seen) if callable(value) and inspect.isfunction(value) else safe(value)
            def unresolved_nested(item):
                return isinstance(item, dict) and (item.get("comparability") == "unresolved" or any(unresolved_nested(v) for v in item.values())) or isinstance(item, list) and any(unresolved_nested(v) for v in item)
            if unresolved_nested(target[name]):
                unresolved.append(name + ":unresolved_callable_dependency")
        except (ProtocolError, TypeError, ValueError):
            unresolved.append(name + ":" + type(value).__name__)
    for name, cell in zip(getattr(getattr(fn, "__code__", None), "co_freevars", ()), getattr(fn, "__closure__", ()) or ()):
        capture(name, cell.cell_contents, captured)
    try:
        dependencies = inspect.getclosurevars(fn)
        for name, value in sorted(dependencies.globals.items()):
            capture(name, value, globals_)
        # Builtins and attribute names are not independent scientific settings.
    except TypeError:
        unresolved.append("callable dependencies unavailable")
    defaults = {}
    capture("positional", getattr(fn, "__defaults__", None), defaults)
    capture("keyword", getattr(fn, "__kwdefaults__", None), defaults)
    return {"name": getattr(fn, "__qualname__", type(fn).__name__), "sourceHash": digest(source),
            "captured": captured, "globals": globals_, "defaults": defaults,
            "comparability": "unresolved" if unresolved else "captured_settings",
            "unresolvedDependencies": sorted(unresolved)}


def _settings(value, bundle):
    value = safe(value)
    replacements = {str(bundle.get(key)): key for key in ("targetArtifactPath", "targetStructurePath") if bundle.get(key)}
    def visit(v):
        if isinstance(v, str) and v in replacements:
            return {"frozenInput": replacements[v], "targetArtifactHash": bundle.get("targetArtifactHash")}
        if isinstance(v, dict):
            return {k: visit(x) for k, x in v.items()}
        if isinstance(v, list):
            return [visit(x) for x in v]
        return v
    return visit(value)


def _sequence(seq):
    return {"sequence": getattr(seq, "sequence", str(seq)), "sequenceType": getattr(seq, "sequence_type", None),
            "metadata": safe(getattr(seq, "metadata", {})),
            "logits": safe(getattr(seq, "logits", None)), "structure": safe(getattr(seq, "structure", None))}


def describe_native(program, search: NativeSearch, bundle):
    if bundle.get("freshNative") is True or bundle.get("nativeExecution") is not None:
        from .program_inspection import assert_native_entrypoints
        assert_native_entrypoints(program)
    fresh = bundle.get("freshNative") is True or bundle.get("nativeExecution") is not None
    if not fresh and type(program).__module__ == "autofold_worker.compatibility.proto_portfolio_v1" and any(
        lane.maximum_candidates is not None or lane.maximum_gpu_seconds is not None for lane in program.lanes
    ):
        raise ProtocolError("NativeSearch uses an aggregate search budget; remove legacy per-lane allocations rather than silently overriding them")
    names = [lane.name for lane in program.lanes] if fresh and hasattr(program, "lanes") else [None] * len(lanes(program))
    projection = []
    for li, lane in enumerate(lanes(program)):
        constructs = list(lane.constructs)
        segment_ids = {id(s): f"lane{li}.construct{ci}.segment{si}" for ci, c in enumerate(constructs) for si, s in enumerate(c.segments)}
        external = []
        def refs(items):
            result = []
            for s in items:
                if id(s) not in segment_ids:
                    segment_ids[id(s)] = f"lane{li}.input{len(external)}"
                    external.append({"id": segment_ids[id(s)], "label": s.label, "type": s.sequence_type,
                        "length": s.sequence_length, "initial": _settings(_sequence(s.original_sequence), bundle)})
                result.append(segment_ids[id(s)])
            return result
        stages = []
        for oi, opt in enumerate(lane.optimizers):
            generators = []
            for gi, gen in enumerate(opt.generators):
                spec = getattr(gen, "_spec", None)
                if spec is None:
                    raise ProtocolError("Native generators must have a pinned registry identity")
                generators.append({"instanceId": f"lane{li}.stage{oi}.generator{gi}", "key": spec.key,
                    "segments": refs(getattr(gen, "segments", [getattr(gen, "segment", None)])),
                    "config": _settings(getattr(gen, "config", {}), bundle), "toolsCalled": list(spec.tools_called)})
            constraints = [{"instanceId": f"lane{li}.stage{oi}.constraint{ci}",
                "function": _function(getattr(c, "function", None)), "backward": _function(getattr(c, "backward", None)),
                "inputs": refs(c.inputs), "config": _settings(getattr(c, "function_config", {}), bundle),
                "backwardConfig": _settings(getattr(c, "backward_config", None), bundle),
                "weight": safe(getattr(c, "weight", None)), "threshold": safe(getattr(c, "threshold", None)), "label": c.label}
                for ci, c in enumerate(opt.constraints)]
            stages.append({"instanceId": f"lane{li}.stage{oi}", "optimizer": type(opt).__name__,
                "config": _settings(opt.config, bundle), "numResults": getattr(opt, "num_results", None),
                "conditioning": _function(getattr(opt, "conditioning_fn", None)),
                "settings": _settings({name: getattr(opt, name) for name in ("num_samples", "proposal_batch_size", "num_steps", "num_proposals", "seed", "target_segment") if hasattr(opt, name) and name != "target_segment"}, bundle),
                "targetSegment": refs([opt.target_segment])[0] if getattr(opt, "target_segment", None) is not None else None,
                "customLogging": _function(getattr(opt, "custom_logging", None)),
                "generators": generators, "constraints": constraints})
        projection.append({"lane": li, **({"name": names[li]} if fresh else {}), "externalInputs": external, "numResults": getattr(lane, "num_results", None), "stages": stages,
            "constructs": [{"id": f"lane{li}.construct{ci}", "label": c.label,
                "segments": [{"id": segment_ids[id(s)], "label": s.label, "type": s.sequence_type,
                    "length": s.sequence_length, "initial": _settings(_sequence(s.original_sequence), bundle)} for s in c.segments]}
                for ci, c in enumerate(constructs)]})
        if bundle.get("freshNative") is True or bundle.get("nativeExecution") is not None:
            projection[-1]["programSeed"] = safe(getattr(lane, "seed", None))
    value = {"format": "autofold.native-search.v1", "budget": search.plan(), "projection": projection}
    # Require explicit final selectors and preserve the current evaluator's domain.
    select_native(program, search, initial=True)
    if len(json.dumps(value)) > 256 * 1024:
        raise ProtocolError("Native construction projection exceeds 256 KiB")
    return value


def select_native(program, search, *, initial=False):
    selected = []
    for output in search.outputs:
        programs = lanes(program)
        if output.lane >= len(programs):
            raise ProtocolError("Native output references an absent lane")
        matches = [c for c in programs[output.lane].constructs if c.label == output.construct]
        if len(matches) != 1:
            raise ProtocolError("Native output requires an unambiguous construct label")
        construct = matches[0]
        segments = list(construct.segments)
        if output.segment is not None:
            segments = [s for s in segments if s.label == output.segment]
            if len(segments) != 1:
                raise ProtocolError("Native output requires an unambiguous segment label")
        if any(s.sequence_type != "protein" for s in segments):
            raise ProtocolError("Current independent evaluator admits protein-sequence outputs only")
        if initial:
            continue
        sequences = segments[0].result_sequences if output.segment is not None or len(segments) == 1 else construct.joined_sequences
        selected.extend((seq, asdict(output)) for seq in sequences)
    if initial:
        return []
    if not initial:
        unique = {}
        for seq, origin in selected:
            unique.setdefault(seq.sequence, (seq, origin))
        if len(unique) > search.maximum_candidates:
            raise ProtocolError("Native final outputs exceeded their frozen candidate limit")
        return list(unique.values())


def _generation_seed_roles(bundle, admitted, calls):
    """Summarize typed seed evidence only for host-bound generation runs.

    The lists intentionally remain separate: the worker observes configured seeds,
    but does not infer a one-to-one relation between search proposals and tool calls.
    """
    if "generationSeed" not in bundle:
        return None
    generation_seed = bundle["generationSeed"]
    if type(generation_seed) is not int or not 0 <= generation_seed <= 0xFFFF_FFFF:
        raise ProtocolError("Host generation seed is invalid")

    descriptor = admitted.get("nativeProjection", admitted)
    projection = descriptor.get("projection", []) if isinstance(descriptor, dict) else []
    effective_program_seeds = []
    declared_predictor_seeds = []
    generator_tools = set()
    for lane in projection:
        lane_id = lane.get("lane")
        seed = lane.get("programSeed")
        if type(lane_id) is int and (seed is None or type(seed) is int and abs(seed) <= 2**53 - 1):
            effective_program_seeds.append({"lane": lane_id, "value": seed,
                "source": "verified_native_projection.programSeed"})
        for stage in lane.get("stages", []):
            for generator in stage.get("generators", []):
                generator_tools.update(tool for tool in generator.get("toolsCalled", []) if isinstance(tool, str))
            for constraint in stage.get("constraints", []):
                config = constraint.get("config")
                value = config.get("predictor_seed") if isinstance(config, dict) else None
                if type(value) is int and abs(value) <= 2**53 - 1:
                    declared_predictor_seeds.append({
                        "lane": lane_id,
                        "stage": stage.get("instanceId"),
                        "constraint": constraint.get("instanceId"),
                        "function": (constraint.get("function") or {}).get("name") if isinstance(constraint.get("function"), dict) else None,
                        "field": "predictor_seed",
                        "value": value,
                        "source": "verified_native_projection.constraint.config",
                    })

    observed_tool_config_seeds = []
    for call in calls:
        has_seed = "configSeed" in call or "configSeeds" in call
        if not has_seed:
            continue
        tool = call.get("tool")
        role = "predictor_tool" if isinstance(tool, str) and tool.endswith("-prediction") else (
            "generator_tool" if tool in generator_tools else "registered_tool"
        )
        item = {"requestId": call["requestId"], "tool": tool, "role": role,
                "source": "verified_native_tool_call.config"}
        if "configSeed" in call:
            item["seed"] = call["configSeed"]
        if "configSeeds" in call:
            item["seeds"] = call["configSeeds"]
        observed_tool_config_seeds.append(item)

    evaluator_seeds = bundle.get("seeds", [])
    if not isinstance(evaluator_seeds, list) or any(type(seed) is not int or abs(seed) > 2**53 - 1 for seed in evaluator_seeds):
        raise ProtocolError("Frozen evaluator seeds are invalid for seed-role evidence")
    return {
        "format": "autofold.generation-seed-roles.v1",
        "hostGenerationSeed": {"value": generation_seed, "source": "trial_bundle.generationSeed"},
        "effectiveProgramSeeds": effective_program_seeds,
        "declaredPredictorSeeds": declared_predictor_seeds,
        "observedToolConfigSeeds": observed_tool_config_seeds,
        "evaluatorSeeds": {"values": evaluator_seeds, "source": "trial_bundle.seeds"},
    }


class NativeSearchObserver:
    """Bound original native sample/request APIs without global dispatch hooks."""
    def __init__(self, program, search, output, registry=None, *, forbid_work=False, fail_closed=True, forbid_run=False, capture_seed_evidence=False):
        self.program, self.search, self.output = program, search, output
        self.forbid_work, self.forbid_run = forbid_work, forbid_run
        self.counts = {"proposals": 0, "samplingCalls": 0, "toolCalls": 0}
        self.calls, self.samplings = [], []
        self.lock = threading.RLock()
        self.generators, self._samples, self._requests = {}, {}, {}
        self.error = None
        self.observation_mechanism = "scoped_native_lifecycle_v1"
        self.sampling_boundary = "public_generator_sample_scoped_v1"
        # Seed fields are additive provenance for new host-bound generation slots.
        # Keep old/direct bundles' receipt bytes unchanged when this is false.
        self.capture_seed_evidence = capture_seed_evidence

    def _stop(self, message):
        from proto_tools.utils.execution_observer import ExecutionCancelled
        self.error = message
        self.control.cancel()
        raise ExecutionCancelled(message)

    def _check(self):
        if self.error:
            self._stop(self.error)
        self.control.check()

    def _debit(self, *, proposals=0, samples=0, tools=0):
        with self.lock:
            self._check()
            for key, n, limit in (("proposals",proposals,self.search.maximum_proposals),
                                  ("samplingCalls",samples,self.search.maximum_sampling_calls),
                                  ("toolCalls",tools,self.search.maximum_tool_calls)):
                if self.counts[key] + n > limit:
                    self._stop(f"Native search exhausted its {key} limit")
            self.counts["proposals"] += proposals
            self.counts["samplingCalls"] += samples
            self.counts["toolCalls"] += tools

    def _save_calls(self):
        with self.lock:
            try:
                self._save_calls_locked()
            except BaseException as error:
                from proto_tools.utils.execution_observer import ObservationPublicationError
                self.control.cancel()
                raise ObservationPublicationError("Native observation publication is unresolved") from error

    def _save_calls_locked(self):
        path = self.output / "native-search/calls.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"counts":self.counts,"calls":self.calls,"samplings":self.samplings,
            "observationMechanism":self.observation_mechanism,"samplingBoundary":self.sampling_boundary},indent=2,allow_nan=False))
        temporary.replace(path)

    def before_sample(self, event):
        with self.lock:
            if self.forbid_work:
                self._stop("Native fixed control or construction cannot sample generators")
            generator = event.generator
            admitted = self.generators.get(id(generator))
            if admitted is None or admitted[0] is not generator:
                self._stop("Native sampling used a generator outside admitted stages")
            if any(state[0] is generator for state in self._samples.values()):
                self._stop("Native generator cannot sample recursively or concurrently")
            proposals = max((len(s.proposal_sequences) for s in generator.segments), default=0)
            self._debit(proposals=proposals, samples=1)
            record = {"sampleId":event.sample_id,"parentSampleId":event.parent_sample_id,"instanceId":admitted[1],
                      "key":generator._spec.key,"proposals":proposals,"status":"started"}
            self.samplings.append(record)
            external = generator._spec.key in {"boltzgen-binder","pxdesign-binder"}
            previous = getattr(generator,"_autofold_timeout",None)
            had_timeout = hasattr(generator,"_autofold_timeout")
            if external:
                remaining = self.search.maximum_wall_seconds - (time.monotonic() - self.started)
                generator._autofold_timeout = min(previous,remaining) if previous is not None else remaining
            self._samples[event.sample_id] = (generator,record,external,had_timeout,previous)
            self._save_calls()
            return record

    def _sample_terminal(self, event, token, error=None):
        with self.lock:
            state = self._samples.get(event.sample_id)
            if state is None or state[1] is not token or token["status"] != "started":
                raise ProtocolError("Native sample callback has no matching admitted token")
            generator, record, external, had_timeout, previous = state
            if external:
                if had_timeout: generator._autofold_timeout = previous
                else: del generator._autofold_timeout
            record["status"] = "failed" if error is not None else "completed"
            if error is not None: record["errorType"] = type(error).__name__
            self._samples.pop(event.sample_id)
            self._save_calls()
            if error is None: self._check()

    def sample_completed(self,event,token): self._sample_terminal(event,token)
    def sample_failed(self,event,token,error): self._sample_terminal(event,token,error)

    def before_request(self, event):
        with self.lock:
            if self.forbid_work:
                self._stop("Native fixed control or construction cannot issue registered requests")
            if event.key not in self.search.allowed_tools:
                self._stop("Native search attempted an undeclared tool: " + event.key)
            self._debit(tools=1)
            values = safe(event.config)
            implicit_msa = event.key in {"boltz2-prediction","chai1-prediction","protenix-prediction","alphafold3-prediction","alphafold2-prediction"}
            if (implicit_msa and values.get("use_msa") is not False) or (values.get("use_msa") is not None and values["use_msa"] is not False):
                self._stop("Native search cannot perform implicit remote MSA searches")
            for field in ("device","backend","endpoint","api_key","url"):
                value = values.get(field)
                if value and (field != "device" or not str(value).startswith(("cpu","cuda"))):
                    self._stop("Native search cannot change execution recipients through " + field)
            record = {"ordinal":len(self.calls),"requestId":event.request_id,"parentRequestId":event.parent_request_id,
                "tool":event.key,"inputHash":digest(safe(event.inputs)),"configHash":digest(values),
                "status":"started","cacheOrigin":"unobserved","wallSeconds":0.0,
                "semantics":"registered_api_request_not_physical_inference"}
            if self.capture_seed_evidence:
                seed = values.get("seed")
                if "seed" in values and (seed is None or type(seed) is int and abs(seed) <= 2**53 - 1):
                    record["configSeed"] = seed
                seeds = values.get("seeds")
                if isinstance(seeds, list) and all(type(value) is int and abs(value) <= 2**53 - 1 for value in seeds):
                    record["configSeeds"] = seeds
            self.calls.append(record)
            self._requests[event.request_id] = (record,time.monotonic())
            self._save_calls()
            return record

    def _request_terminal(self,event,token,error=None):
        with self.lock:
            state = self._requests.get(event.request_id)
            if state is None or state[0] is not token or token["status"] != "started":
                raise ProtocolError("Native request callback has no matching admitted token")
            token.update(status="failed" if error is not None else "completed",cacheOrigin=event.cache_origin,wallSeconds=time.monotonic()-state[1])
            if error is not None: token["errorType"] = type(error).__name__
            else:
                token["outputSuccess"] = getattr(event.result,"success",True) is not False
                token["outputHash"] = digest(safe(event.result))
            self._save_calls()
            if error is None: self._check()

    def request_completed(self,event,token): self._request_terminal(event,token)
    def request_failed(self,event,token,error): self._request_terminal(event,token,error)

    def __enter__(self):
        from contextlib import ExitStack
        from .native_lifecycle import native_api
        sampling, requests = native_api()
        self.started = time.monotonic()
        self.control = requests.ExecutionControl(deadline=self.started+self.search.maximum_wall_seconds)
        seen=set()
        for li,lane in enumerate(lanes(self.program)):
            for oi,opt in enumerate(lane.optimizers):
                for gi,generator in enumerate(opt.generators):
                    if id(generator) in seen: raise ProtocolError("Native stages require fresh generator instances")
                    seen.add(id(generator)); self.generators[id(generator)]=(generator,f"lane{li}.stage{oi}.generator{gi}")
        self._stack=ExitStack()
        try:
            self._stack.enter_context(requests.request_observation_scope(self,self.control,require_scoped_calls=True,keep_unobserved_closed=True))
            self._stack.enter_context(sampling.sampling_observation_scope(self,self.control,require_scoped_calls=True,
                allow_program_execution=not self.forbid_run,keep_unobserved_closed=True))
            self._save_calls()
        except BaseException:
            self._stack.close();raise
        return self

    def __exit__(self,*error):
        try:
            self.elapsed=time.monotonic()-self.started
            for generator,record,external,had_timeout,previous in self._samples.values():
                if external:
                    if had_timeout: generator._autofold_timeout=previous
                    elif hasattr(generator,"_autofold_timeout"): del generator._autofold_timeout
            try:
                self._save_calls()
            except BaseException as publication_error:
                from proto_tools.utils.execution_observer import ObservationPublicationError, retain_observation_failure
                self.control.cancel()
                if error[1] is not None:
                    retain_observation_failure(error[1],publication_error,"Final native receipt")
                else:
                    raise ObservationPublicationError("Final native observation publication is unresolved") from publication_error
        finally:
            self._stack.__exit__(*error)
        return False

    def verify(self):
        self._check()
        if any(item["status"] == "started" for item in self.samplings+self.calls):
            self._stop("Native lifecycle has an unresolved return")
        if any(call["status"] == "completed" and call["cacheOrigin"] == "unobserved" for call in self.calls):
            self._stop("Native completed request lacks its original cache branch")


def capture_native(program, search, admitted, observer, bundle, output):
    selected = select_native(program, search)
    program._autofold_selected_sequences = selected
    program._autofold_native_projection = admitted.get("nativeProjection", admitted)
    seed_roles = _generation_seed_roles(bundle, admitted, observer.calls)
    if seed_roles is not None:
        program._autofold_native_seed_roles = seed_roles
    value = {"format": "autofold.native-search-receipt.v1", "runId": bundle["runId"], "programHash": bundle["programHash"],
        **({"observation": "scoped_native_lifecycle_v1"} if observer.observation_mechanism == "scoped_native_lifecycle_v1" else {}),
        "admission": admitted, "counts": observer.counts, "calls": observer.calls, "samplings": observer.samplings,
        "wallSeconds": getattr(observer, "elapsed", time.monotonic() - observer.started), "observationMechanism": observer.observation_mechanism,
        "samplingBoundary": observer.sampling_boundary,
        **({"laneFailures": safe(getattr(program, "lane_failures", []))} if observer.observation_mechanism == "scoped_native_lifecycle_v1" else {}),
        "lanes": [{"lane": i, "stages": [{"stage": oi, "history": safe(getattr(o, "history", [])),
            "energyScores": safe(getattr(o, "energy_scores", []))} for oi, o in enumerate(lane.optimizers)],
            "constructs": [{"label": c.label, "segments": [{"label": s.label, "results": [_sequence(seq) for seq in s.result_sequences]}
                for s in c.segments]} for c in lane.constructs]} for i, lane in enumerate(lanes(program))],
        "selected": [{"origin": origin, "sequence": _sequence(seq)} for seq, origin in selected],
        **({"seedRoles": seed_roles} if seed_roles is not None else {})}
    content = json.dumps(value, sort_keys=True, indent=2, allow_nan=False)
    if len(content.encode()) > 32 * 1024 * 1024:
        raise ProtocolError("Native search evidence exceeds the 32 MiB artifact limit")
    path = output / "native-search" / "receipt.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content + "\n")
    program._autofold_native_receipt = {"path": "native-search/receipt.json", "hash": "sha256:" + hashlib.sha256((content + "\n").encode()).hexdigest()}
    return [seq.sequence for seq, _ in selected]
