"""Supported native lifecycle admission and durable request correlation.

Fresh disposable processes retain the native closed fence until process exit.
No methods, dispatch backends, cache branches or registry retries are replaced.
"""
from __future__ import annotations
from contextlib import ExitStack
import importlib
import json
from pathlib import Path
import threading
import time
from typing import Any
from .protocol import ProtocolError

OBSERVATION = "scoped_native_lifecycle_v1"


def native_api(root: Path | None = None):
    """Verify real APIs and their source origins before authored imports."""
    try:
        sampling = importlib.import_module("proto_language.core.execution_observer")
        requests = importlib.import_module("proto_tools.utils.execution_observer")
    except ImportError as error:
        raise ProtocolError("Fresh Proto source has no supported scoped native lifecycle APIs") from error
    expected = ((sampling, "SCOPED_SAMPLING_API_VERSION"), (sampling, "SCOPED_PROGRAM_GUARD_API_VERSION"),
                (sampling, "HOSTED_PROCESS_FENCE_API_VERSION"), (requests, "SCOPED_REQUEST_API_VERSION"),
                (requests, "HOSTED_PROCESS_FENCE_API_VERSION"))
    if any(getattr(module, marker, None) != 1 for module, marker in expected):
        raise ProtocolError("Fresh Proto execution requires supported scoped lifecycle, program guard and retained hosted fence APIs")
    if root is not None:
        for module, path in ((sampling, root / "proto_language/core/execution_observer.py"),
                             (requests, root / "proto-tools/proto_tools/utils/execution_observer.py")):
            if Path(module.__file__).resolve() != path.resolve():
                raise ProtocolError("Native lifecycle API imported an unbound package origin")
    return sampling, requests


class RequestRecorder:
    """Record admitted original registry calls before effects and paired outcomes.

    The opaque native callback token is the one owned record. Atomic sidecars
    preserve started intents when terminal publication cannot be confirmed.
    Cache origins describe registered API branches, not physical GPU invocation.
    """
    def __init__(self, path: Path, *, admit=None, output_hash=None, root_tool=None):
        self.path, self.admit, self.output_hash, self.root_tool = path, admit, output_hash, root_tool
        self.records: list[dict[str, Any]] = []
        self.lock = threading.RLock()
        self._tokens: dict[str, tuple[dict[str, Any], float]] = {}

    def _publish(self):
        try:
            self._publish_bytes()
        except BaseException as error:
            from proto_tools.utils.execution_observer import ObservationPublicationError
            control = getattr(self,"control",None)
            if control is not None: control.cancel()
            raise ObservationPublicationError("Native request receipt publication is unresolved") from error

    def _publish_bytes(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        content = json.dumps({"format": "autofold.native-request-journal.v1", "entries": self.records}, indent=2, allow_nan=False)
        if len(content.encode()) > 32 * 1024 * 1024:
            raise ProtocolError("Native request receipt exceeds its bounded byte capacity")
        temporary.write_text(content)
        temporary.replace(self.path)

    def before_request(self, event):
        with self.lock:
            if self.root_tool is not None:
                from proto_tools.utils.execution_observer import ExecutionCancelled
                if event.parent_request_id is None:
                    if event.key != self.root_tool or any(record["parentRequestId"] is None for record in self.records):
                        raise ExecutionCancelled("Frozen measurement cannot start an additional or different root request")
                elif event.parent_request_id not in self._tokens:
                    raise ExecutionCancelled("Frozen measurement request escaped its admitted native root")
            if self.admit is not None:
                self.admit(event)
            from .native_search import digest, safe
            record = {"inputHash": digest(safe(event.inputs)), "configHash": digest(safe(event.config)), "requestId": event.request_id, "parentRequestId": event.parent_request_id,
                      "tool": event.key, "status": "started", "cacheOrigin": "unobserved", "wallSeconds": 0.0}
            if event.request_id in self._tokens:
                raise ProtocolError("Native request identity was reused")
            if len(self.records) >= 4096:
                from proto_tools.utils.execution_observer import ExecutionCancelled
                raise ExecutionCancelled("Native request receipt exceeds its bounded event capacity")
            self.records.append(record)
            self._tokens[event.request_id] = (record, time.monotonic())
            self._publish()
            return record

    def _terminal(self, event, token, error=None):
        with self.lock:
            owned = self._tokens.get(event.request_id)
            if owned is None or owned[0] is not token or token["status"] != "started":
                raise ProtocolError("Native request callback does not match its admitted token")
            record, started = owned
            record.update(status="failed" if error is not None else "completed", cacheOrigin=event.cache_origin,
                          wallSeconds=time.monotonic() - started)
            if error is not None:
                record["errorType"] = type(error).__name__
            else:
                record["outputSuccess"] = getattr(event.result, "success", True) is not False
                if self.output_hash is not None:
                    record["outputHash"] = self.output_hash(event.result)
            self._publish()

    def request_completed(self, event, token):
        self._terminal(event, token)

    def request_failed(self, event, token, error):
        self._terminal(event, token, error)

    def receipt(self, root_tool):
        with self.lock:
            roots = [record for record in self.records if record["parentRequestId"] is None]
            if len(roots) != 1 or roots[0]["tool"] != root_tool or roots[0]["status"] != "completed" or roots[0].get("outputSuccess") is False:
                raise ProtocolError("Frozen evaluation lacks its exact completed native root request")
            if any(record["status"] not in {"completed", "failed"} for record in self.records) or roots[0]["cacheOrigin"] == "unobserved":
                raise ProtocolError("Frozen evaluation has unresolved native requests or cache origin")
            return json.loads(json.dumps({"format": "autofold.native-request-observation.v1",
                "rootRequestId": roots[0]["requestId"], "entries": self.records}, allow_nan=False))


class DenySampling:
    """Reject sampling before its scientific body in a frozen measurement scope."""
    def before_sample(self, event):
        from proto_tools.utils.execution_observer import ExecutionCancelled
        raise ExecutionCancelled("Frozen measurement cannot sample authored generators")


def measurement_scope(observer, seconds):
    """Scope a whole frozen call and native capture; retain the closed fence."""
    sampling, requests = native_api()
    control = requests.ExecutionControl(deadline=time.monotonic() + seconds)
    observer.control = control
    stack = ExitStack()
    try:
        stack.enter_context(requests.request_observation_scope(observer, control, require_scoped_calls=True, keep_unobserved_closed=True))
        stack.enter_context(sampling.sampling_observation_scope(DenySampling(), control, require_scoped_calls=True,
                                                              allow_program_execution=False, keep_unobserved_closed=True))
    except BaseException:
        stack.close()
        raise
    return stack
