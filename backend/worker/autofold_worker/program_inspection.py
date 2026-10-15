"""Shared native object inspection. No optimizer or model execution.

Descriptions and optional CPU probes are advisory; fixed construction fidelity
uses only executable settings. Legacy fixed inventories retain their shape.
"""
from __future__ import annotations
from typing import Any

_native_entrypoints = None

def pin_native_entrypoints():
    """Capture original native public methods before importing authored code."""
    global _native_entrypoints
    if _native_entrypoints is None:
        from proto_language.core import Program
        from proto_language.core.generator import Generator
        from proto_language import core
        Portfolio = getattr(core, "PortfolioProgram", None)
        _native_entrypoints = (Program, Program.run, Generator, Generator.sample, Program.run_stage, Portfolio, getattr(Portfolio, "run", None))
    return _native_entrypoints

def assert_native_entrypoints(program):
    """Require supported native orchestration, without rewriting its settings."""
    import inspect
    from .protocol import ProtocolError
    Program, run, Generator, sample, run_stage, Portfolio, portfolio_run = pin_native_entrypoints()
    def bound(value, name, native):
        method = getattr(value, name, None)
        return inspect.ismethod(method) and method.__self__ is value and method.__func__ is native
    if Portfolio is not None and isinstance(program, Portfolio):
        if not bound(program, "run", portfolio_run) or Portfolio.run is not portfolio_run:
            raise ProtocolError("Fresh portfolios require the original native PortfolioProgram.run()")
        program.validate()
        native_lanes = program.programs
    else:
        native_lanes = (program,)
    if Program.run is not run or Program.run_stage is not run_stage or Generator.sample is not sample:
        raise ProtocolError("Fresh native trials require original native Program.run/run_stage and Generator.sample()")
    for lane in native_lanes:
        if not isinstance(lane, Program) or not bound(lane, "run", run) or not bound(lane, "run_stage", run_stage):
            raise ProtocolError("Fresh native trials require the original native Program.run/run_stage()")
        for optimizer in lane.optimizers:
            for generator in optimizer.generators:
                if not isinstance(generator, Generator) or not bound(generator, "sample", sample):
                    raise ProtocolError("Fresh generators require the original base Generator.sample()")

def describe_fixed(program, control, bundle):
    """Freeze complete native control settings and its explicit selected panel."""
    from .native_search import describe_native, select_native
    from .protocol import ProtocolError
    assert_native_entrypoints(program)
    result = inspect_static_construction(program, semantic=True)
    from .native_search import lanes
    controls = lanes(program)
    if result["generatorCount"] != 0 or any(len(lane.optimizers) != 1 for lane in controls) or result["proposalSources"] != ["existing_results"] * len(controls):
        raise ProtocolError("Native fixed controls require one existing_results optimizer per independent native lane without generators")
    search = control.observer_budget(bundle["candidateBudget"])
    result["nativeProjection"] = describe_native(program, search, bundle)
    panel = [sequence.sequence for sequence, _ in select_native(program, search)]
    if not bundle["submissionSize"] <= len(panel) <= bundle["candidateBudget"]:
        raise ProtocolError("Native fixed selected pool must contain the final submission within the candidate budget")
    result["fixedSequences"] = panel
    return result

def inspect_program(program, kind="native", *, probes=True):
    optimizers = list(getattr(program, "optimizers", []))
    fixed_sequences = []
    constraint_settings = []
    for index, optimizer in enumerate(optimizers):
        for constraint in getattr(optimizer, "constraints", []):
            function = getattr(constraint, "function", None)
            config = getattr(constraint, "function_config", None)
            fields = getattr(type(config), "model_fields", {})
            parameters = config.model_dump(mode="json") if hasattr(config, "model_dump") else config if isinstance(config, dict) else {}
            threshold = getattr(constraint, "threshold", None)
            probe = None
            lengths = [getattr(segment, "sequence_length", None) for segment in getattr(constraint, "inputs", [])]
            # Only pinned registry functions declared CPU-only and tool-free are
            # eligible. Never execute an authored callable or a model-backed
            # constraint merely to describe a program.
            if probes and len(lengths) == 1 and isinstance(lengths[0], int) and 0 < lengths[0] <= 256 and getattr(function, "__module__", "").startswith("proto_language."):
                try:
                    import math
                    from proto_language.constraint import ConstraintRegistry
                    from proto_language.core import Sequence
                    spec = next((item for item in ConstraintRegistry.list_all() if item.function is function), None)
                    if spec is not None and not spec.uses_gpu and not spec.tools_called and "protein" in spec.supported_sequence_types:
                        length = lengths[0]
                        controls = ["A" * length, ("ACDEFGHIKLMNPQRSTVWY" * ((length + 19) // 20))[:length]]
                        outputs = function([(Sequence(sequence, "protein"),) for sequence in controls], config)
                        if len(outputs) != len(controls):
                            raise ValueError("Constraint probe returned inconsistent cardinality")
                        probe = {
                            "scope": "Native CPU function on synthetic sequence controls only; not campaign evidence or optimizer execution.",
                            "rows": [{
                                "length": len(sequence), "uniqueResidues": len(set(sequence)),
                                "score": float(output.score) if math.isfinite(output.score) else str(output.score),
                                "passesConfiguredFilter": output.score <= threshold if threshold is not None else None,
                            } for sequence, output in zip(controls, outputs)],
                        }
                except Exception as error:
                    # Optional diagnostics must not change program admissibility.
                    probe = {"status": "unavailable", "reason": str(error)[:300]}
            constraint_settings.append({
                "optimizerIndex": index,
                "function": f"{getattr(function, '__module__', '')}.{getattr(function, '__name__', type(constraint).__name__)}",
                "definition": (getattr(function, "__doc__", None) or "").strip()[:600],
                "parameters": parameters,
                "parameterDescriptions": {name: field.description or "" for name, field in fields.items() if name in parameters},
                "role": "filter" if threshold is not None else "scoring",
                "effect": "Keep proposals whose constraint score is <= filterThreshold." if threshold is not None else "No hard score threshold is configured. Finite penalties contribute ranking energy; positive finite values do not reject candidates. A min/max config parameter is not itself a rejection threshold.",
                "filterThreshold": threshold,
                "inputLengths": lengths,
                **({"cpuProbe": probe} if probe is not None else {}),
            })
    for construct in getattr(program, "constructs", []):
        for segment in getattr(construct, "segments", []):
            for observed in getattr(segment, "result_sequences", []):
                sequence = getattr(observed, "sequence", observed)
                if isinstance(sequence, str) and sequence and sequence not in fixed_sequences:
                    fixed_sequences.append(sequence)
    def count(value):
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None
    return {
        "kind": kind,
        "optimizerCount": len(optimizers),
        "constructCount": len(getattr(program, "constructs", [])),
        "generatorCount": sum(len(getattr(optimizer, "generators", [])) for optimizer in optimizers),
        "proposalSources": [getattr(getattr(optimizer, "config", None), "proposal_source", None) for optimizer in optimizers],
        "fixedSequences": fixed_sequences,
        **({"constraintSettings": constraint_settings} if constraint_settings else {}),
        "programResultCount": count(getattr(program, "num_results", None)),
        "optimizerSamples": [{
            "numSamples": count(getattr(optimizer, "num_samples", None)),
            "numResults": count(getattr(optimizer, "num_results", None)),
            "proposalBatchSize": count(getattr(optimizer, "proposal_batch_size", None)),
        } for optimizer in optimizers],
    }


def inspect_static_construction(program: Any, *, semantic: bool = False) -> dict[str, Any]:
    observed = inspect_program(program, "native", probes=False)
    settings = observed.pop("constraintSettings", [])
    result = {"format": "autofold.static-construction.v1", **observed}
    if semantic:
        result["semantics"] = "native_object_v2"
        if settings:
            result["constraintSettings"] = [{key: item[key] for key in
                ("optimizerIndex", "function", "parameters", "role", "filterThreshold", "inputLengths")}
                for item in settings]
    return result
