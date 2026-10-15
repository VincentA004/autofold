"""Explicit historical Python frame/dispatch monitoring compatibility.

Fresh workers use supported native scoped lifecycle APIs. This adapter exists
only for historical fixture/read compatibility; original requests keep their
original frozen worker implementation.
"""
from __future__ import annotations
import inspect, json, threading, sys, time
from ..protocol import ProtocolError
from ..native_search import NativeExecutionStopped, safe, digest

def lanes(program):
    from .proto_portfolio_v1 import ProtoPortfolioProgram
    return program.programs if isinstance(program, ProtoPortfolioProgram) else [program]

class NativeSearchObserver:
    """Scoped observation without rewriting scientific optimizer settings."""
    def __init__(self, program, search, output, registry=None, *, forbid_work=False, fail_closed=False, forbid_run=False):
        self.program, self.search, self.output, self.registry = program, search, output, registry
        self.counts = {"proposals": 0, "samplingCalls": 0, "toolCalls": 0}
        self.calls, self.samplings = [], []
        self.lock = threading.RLock()
        self.frames = {}
        self.sampling_frames = {}
        self.generators = {}
        self.sampling_codes = set()
        self.monitored_codes = set()
        self.monitoring_id = None
        self.observation_mechanism = "uninitialized"
        self.sampling_boundary = "public_generator_sample_monitoring_v1"
        self.error = None
        self.forbid_work = forbid_work
        self.fail_closed = fail_closed
        self.forbid_run = forbid_run
        self.forbidden_run_codes = set()
        self.forbidden_request_codes = set()
        self.dispatch_installed = False

    def _check(self):
        if self.error:
            raise ProtocolError(self.error)
        if time.monotonic() - self.started >= self.search.maximum_wall_seconds:
            self.error = "Native search exceeded its wall-time limit"
            raise ProtocolError(self.error)

    def _debit(self, proposals=0, samples=0, tools=0):
        with self.lock:
            self._check()
            for key, n, limit in (("proposals", proposals, self.search.maximum_proposals),
                                  ("samplingCalls", samples, self.search.maximum_sampling_calls),
                                  ("toolCalls", tools, self.search.maximum_tool_calls)):
                if self.counts[key] + n > limit:
                    self.error = f"Native search exhausted its {key} limit"
                    raise ProtocolError(self.error)
            self.counts["proposals"] += proposals
            self.counts["samplingCalls"] += samples
            self.counts["toolCalls"] += tools

    def _sample_started(self, frame):
        """Debit before Proto's public sample() body, without replacing methods.

        Python monitoring supplies an entry callback before any generator work.
        Frame identity correlates recursion/threads, rather than a shared code
        stack that could consume the wrong return. Proto retains forwarding,
        tied-segment mirroring, metadata cleanup and optimizer signatures.
        """
        if self.forbid_work:
            self.error = "Native fixed control or construction cannot sample generators"
            raise ProtocolError(self.error)
        generator = frame.f_locals.get("self")
        admitted = self.generators.get(id(generator))
        if admitted is None or admitted[0] is not generator:
            self.error = "Native sampling used a generator outside its admitted stages"
            raise ProtocolError(self.error)
        with self.lock:
            if any(state[0] is generator for state in self.sampling_frames.values()):
                self.error = "Native generator cannot sample recursively or concurrently"
                raise ProtocolError(self.error)
            proposals = max((len(s.proposal_sequences) for s in generator.segments), default=0)
            self._debit(proposals=proposals, samples=1)
            record = {"instanceId": admitted[1], "key": generator._spec.key,
                      "proposals": proposals, "status": "started"}
            self.samplings.append(record)
            external = generator._spec.key in {"boltzgen-binder", "pxdesign-binder"}
            previous_timeout = getattr(generator, "_autofold_timeout", None)
            had_timeout = hasattr(generator, "_autofold_timeout")
            if external:
                remaining = self.search.maximum_wall_seconds - (time.monotonic() - self.started)
                generator._autofold_timeout = min(previous_timeout, remaining) if previous_timeout is not None else remaining
            self.sampling_frames[id(frame)] = (generator, record, external, had_timeout, previous_timeout)
            self._save_calls()

    def _sample_finished(self, frame, error=None):
        with self.lock:
            state = self.sampling_frames.pop(id(frame), None)
            if state is None:
                return
            generator, record, external, had_timeout, previous_timeout = state
            if external:
                if had_timeout:
                    generator._autofold_timeout = previous_timeout
                else:
                    del generator._autofold_timeout
            record["status"] = "completed"
            try:
                if error is not None:
                    record.update(status="failed", errorType=type(error).__name__, error=str(error)[:1000])
                else:
                    self._check()
            except BaseException as failure:
                record.update(status="failed", errorType=type(failure).__name__, error=str(failure)[:1000])
                raise
            finally:
                self._save_calls()

    def _dispatch(self, key, inputs, config):
        try:
            return self._dispatch_admitted(key, inputs, config)
        except Exception as error:
            if self.fail_closed:
                raise NativeExecutionStopped(str(error)) from error
            raise

    def _dispatch_admitted(self, key, inputs, config):
        if self.forbid_work:
            self.error = "Native fixed control or construction cannot issue registered requests"
            raise ProtocolError(self.error)
        if key not in self.search.allowed_tools:
            self.error = f"Native search attempted an undeclared tool: {key}"
            raise ProtocolError(self.error)
        values = safe(config)
        implicit_msa = key in {"boltz2-prediction", "chai1-prediction", "protenix-prediction", "alphafold3-prediction", "alphafold2-prediction"}
        if (implicit_msa and values.get("use_msa") is not False) or (values.get("use_msa") is not None and values["use_msa"] is not False):
            self.error = "Native search cannot perform implicit remote MSA searches"
            raise ProtocolError(self.error)
        for field in ("device", "backend", "endpoint", "api_key", "url"):
            value = values.get(field)
            if value and (field != "device" or not str(value).startswith(("cpu", "cuda"))):
                self.error = f"Native search cannot change execution recipients through {field}"
                raise ProtocolError(self.error)
        self._debit(tools=1)
        # The public hook is observation only: falling through preserves Proto's
        # cache, preprocessing, pool and postprocessing exactly once. A scoped
        # return observer captures the final API output without redispatching.
        with self.lock:
            record = {"ordinal": len(self.calls), "tool": key, "inputHash": digest(safe(inputs)),
                "configHash": digest(values), "status": "started", "cacheOrigin": "unobserved",
                "semantics": "registered_api_request_not_physical_inference"}
            self.calls.append(record)
            frame = sys._getframe(2)
            self.frames[id(frame)] = record
            if self.monitoring_id is not None:
                code = frame.f_code
                if code not in self.monitored_codes:
                    self.monitored_codes.add(code)
                    events = sys.monitoring.events
                    # Keep the public sampling entry event if this is shared code.
                    flags = events.PY_RETURN | (events.PY_START if code in self.sampling_codes else 0)
                    sys.monitoring.set_local_events(self.monitoring_id, code, flags)
            self._save_calls()
        return None

    def _record_return(self, record, value):
        try:
            record.update(status="completed" if value is not None and getattr(value, "success", True) is not False else "failed",
                          outputHash=digest(safe(value)))
        except Exception as error:
            record.update(status="failed", errorType=type(error).__name__, error=str(error)[:1000])
            self.error = "Native tool output could not be recorded"
        self._save_calls()

    def _monitored_start(self, code, offset):
        try:
            if code in self.forbidden_run_codes:
                self.error = "Native construction cannot execute Program.run()"
                raise ProtocolError(self.error)
            if code in self.forbidden_request_codes:
                self.error = "Native fixed control or construction cannot issue registered requests"
                raise ProtocolError(self.error)
            self._sample_started(sys._getframe(1))
        except Exception as error:
            if self.fail_closed:
                raise NativeExecutionStopped(str(error)) from error
            raise

    def _monitored_return(self, code, offset, value):
        frame = sys._getframe(1)
        self._sample_finished(frame)
        with self.lock:
            record = self.frames.pop(id(frame), None)
            if record is not None:
                self._record_return(record, value)

    def _monitored_unwind(self, code, offset, error):
        frame = sys._getframe(1)
        self._sample_finished(frame, error)
        with self.lock:
            record = self.frames.pop(id(frame), None)
            if record is not None:
                record.update(status="failed", errorType=type(error).__name__, error=str(error)[:1000])
                self._save_calls()

    def _start_observation(self):
        monitoring = getattr(sys, "monitoring", None)
        if monitoring is not None:
            for identifier in (5, 4, 3, 2, 1, 0):
                if monitoring.get_tool(identifier) is None:
                    monitoring.use_tool_id(identifier, "autofold-native-receipts")
                    self.monitoring_id = identifier
                    monitoring.register_callback(identifier, monitoring.events.PY_START, self._monitored_start)
                    monitoring.register_callback(identifier, monitoring.events.PY_RETURN, self._monitored_return)
                    monitoring.register_callback(identifier, monitoring.events.PY_UNWIND, self._monitored_unwind)
                    monitoring.set_events(identifier, monitoring.events.PY_UNWIND)
                    for code in self.sampling_codes | self.forbidden_request_codes | self.forbidden_run_codes:
                        self.monitored_codes.add(code)
                        monitoring.set_local_events(identifier, code, monitoring.events.PY_START | monitoring.events.PY_RETURN)
                    self.observation_mechanism = "python_code_local_monitoring_v1"
                    return
            raise ProtocolError("Native call observation has no available Python monitoring slot")
        # Fail closed before any sampling. Older profile callbacks cannot
        # distinguish a None return from exception unwinding without taking
        # over a second global tracing context. Fresh native search needs 3.12.
        raise ProtocolError("Native search observation requires Python 3.12 or newer")

    def _stop_observation(self):
        if self.monitoring_id is not None:
            identifier = self.monitoring_id
            sys.monitoring.set_events(identifier, 0)
            for code in self.monitored_codes:
                sys.monitoring.set_local_events(identifier, code, 0)
            sys.monitoring.register_callback(identifier, sys.monitoring.events.PY_START, None)
            sys.monitoring.register_callback(identifier, sys.monitoring.events.PY_RETURN, None)
            sys.monitoring.register_callback(identifier, sys.monitoring.events.PY_UNWIND, None)
            sys.monitoring.free_tool_id(identifier)
            self.monitoring_id = None

    def _save_calls(self):
        with self.lock:
            try:
                self._save_calls_locked()
            except Exception as error:
                self.error = "Native observation publication is unresolved"
                if self.fail_closed:
                    raise NativeExecutionStopped(self.error) from error
                raise

    def _save_calls_locked(self):
        path = self.output / "native-search" / "calls.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"counts": self.counts, "calls": self.calls, "samplings": self.samplings, "observationMechanism": self.observation_mechanism, "samplingBoundary": self.sampling_boundary}, indent=2, allow_nan=False))
        temporary.replace(path)

    def __enter__(self):
        if self.registry is None:
            from proto_tools import ToolRegistry
            self.registry = ToolRegistry
        if self.registry.dispatch_backend_configured():
            raise ProtocolError("Native search requires the original local registry backend")
        self.started = time.monotonic()
        # Fixed controls have no admitted generators. Still monitor the public
        # base boundary to reject an unassigned generator before its body.
        if self.forbid_work:
            from .program_inspection import pin_native_entrypoints
            self.sampling_codes.add(pin_native_entrypoints()[3].__code__)
            for spec in self.registry.list_all():
                function = spec.function
                code = getattr(function, "__code__", None)
                if code is None:
                    raise ProtocolError("Native registered requests require an observable public wrapper")
                self.forbidden_request_codes.add(code)
            if not self.forbidden_request_codes:
                raise ProtocolError("Native construction requires pinned registered request boundaries")
        if self.forbid_run:
            from .program_inspection import pin_native_entrypoints
            self.forbidden_run_codes.add(pin_native_entrypoints()[1].__code__)
        seen = set()
        for li, lane in enumerate(lanes(self.program)):
            for oi, opt in enumerate(lane.optimizers):
                for gi, gen in enumerate(opt.generators):
                    if id(gen) in seen:
                        raise ProtocolError("Native stages require fresh generator instances")
                    seen.add(id(gen))
                    method = getattr(gen, "sample", None)
                    if not inspect.ismethod(method) or method.__self__ is not gen or not hasattr(method.__func__, "__code__"):
                        raise ProtocolError("Native generators require an observable public sample() method")
                    if inspect.isgeneratorfunction(method) or inspect.iscoroutinefunction(method):
                        raise ProtocolError("Native public sample() must be synchronous")
                    self.generators[id(gen)] = (gen, f"lane{li}.stage{oi}.generator{gi}")
                    self.sampling_codes.add(method.__func__.__code__)
        installing_dispatch = False
        try:
            self._start_observation()
            if not self.forbid_work:
                installing_dispatch = True
                self.registry.configure_dispatch_backend(self._dispatch)
                self.dispatch_installed = True
        except BaseException:
            self._stop_observation()
            if installing_dispatch:
                self.registry.clear_dispatch_backend()
            raise
        return self

    def __exit__(self, *error):
        self.elapsed = time.monotonic() - self.started
        self._stop_observation()
        if self.dispatch_installed:
            self.registry.clear_dispatch_backend()
        # Interrupted callbacks can leave an unresolved sample. Restore only
        # our owned CLI timeout field; no Proto method ever needs restoration.
        for generator, record, external, had_timeout, previous_timeout in self.sampling_frames.values():
            record.update(status="interrupted", errorType="UnresolvedSampleReturn")
            if external:
                if had_timeout:
                    generator._autofold_timeout = previous_timeout
                elif hasattr(generator, "_autofold_timeout"):
                    del generator._autofold_timeout
        self.sampling_frames.clear()
        self._save_calls()
        return False

    def verify(self):
        self._check()
        if any(sample["status"] in {"started", "interrupted"} for sample in self.samplings):
            raise ProtocolError("Native public sample has an unresolved return")
        if any(call["status"] == "started" for call in self.calls):
            raise ProtocolError("Native registered API request has an unresolved return")

