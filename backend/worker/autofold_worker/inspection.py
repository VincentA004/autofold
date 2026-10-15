"""Construction-only JSON inspection API. Native registries own executable schemas."""
from __future__ import annotations
import sys

def extract(arguments):
    import ast, json, pathlib, sys
    tree = ast.parse(pathlib.Path(arguments[0]).read_text(encoding="utf-8"), filename=arguments[0])
    matches = [node for node in tree.body if isinstance(node, (ast.Assign, ast.AnnAssign)) and any(
        isinstance(target, ast.Name) and target.id == "AUTOFOLD_WORKFLOW"
        for target in ((node.targets if isinstance(node, ast.Assign) else [node.target]))
    )]
    if not matches:
        raise SystemExit(3)
    if len(matches) != 1:
        raise SystemExit("AUTOFOLD_WORKFLOW must be assigned exactly once")
    print(json.dumps(ast.literal_eval(matches[0].value)))

def describeTrial(arguments):
    import ast, importlib.util, json, pathlib, sys
    trial_path = pathlib.Path(arguments[0]).resolve()
    spec = importlib.util.spec_from_file_location("autofold_describe_trial", trial_path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"Cannot load Proto trial module: {trial_path}")
    bundle = json.loads(sys.stdin.read())
    fresh = bundle.get("freshNative") is True
    tree = ast.parse(trial_path.read_text(encoding="utf-8"), filename=str(trial_path))
    matches = [node for node in tree.body if isinstance(node, (ast.Assign, ast.AnnAssign)) and any(
        isinstance(target, ast.Name) and target.id == "AUTOFOLD_WORKFLOW"
        for target in (node.targets if isinstance(node, ast.Assign) else [node.target])
    )]
    if len(matches) > 1:
        raise SystemExit("AUTOFOLD_WORKFLOW must be assigned exactly once")
    if fresh and matches:
        raise SystemExit("Fresh native trials cannot declare AUTOFOLD_WORKFLOW")
    legacy_workflow = ast.literal_eval(matches[0].value) if matches else None
    attempted_tools = []
    def forbid_execution(key, inputs, config):
        attempted_tools.append(key)
        raise RuntimeError("Native tool execution is forbidden during program inspection: " + key)
    try:
        from proto_tools import ToolRegistry
    except ModuleNotFoundError as error:
        if error.name != "proto_tools":
            raise
        # Standard-library object-inspection fixtures have no native dispatcher.
        # Real native execution still requires verified runtime pins/readiness.
        ToolRegistry = None
    if fresh:
        from autofold_worker.program_inspection import pin_native_entrypoints
        from autofold_worker.native_lifecycle import native_api
        import os
        expected = os.environ.get("AUTOFOLD_EXPECTED_PROTO_ROOT")
        native_api(pathlib.Path(expected) if expected else None)
        pin_native_entrypoints()
    if ToolRegistry is not None and not fresh:
        ToolRegistry.configure_dispatch_backend(forbid_execution)
    module = importlib.util.module_from_spec(spec)
    from autofold_worker.proto_trial import load_authored_trial
    from autofold_worker.generator_spec import inspect_generator_specs
    from contextlib import nullcontext
    import tempfile
    from types import SimpleNamespace
    from pathlib import Path
    from autofold_worker.native_search import NativeSearch, NativeOutput, NativeSearchObserver
    with tempfile.TemporaryDirectory(prefix="autofold-inspection-") as temporary:
        guard = NativeSearchObserver(SimpleNamespace(optimizers=[]), NativeSearch(1,1,1,1,30,(NativeOutput("construction"),)), Path(temporary), forbid_work=True, fail_closed=True, forbid_run=True) if fresh else nullcontext()
        with guard as observer:
            spec.loader.exec_module(module)
            trial = load_authored_trial(module, bundle)
            description = _describe_constructed(trial, bundle, legacy_workflow)
            if fresh:
                observer.verify()
    if attempted_tools:
        raise SystemExit("Program inspection attempted native tool execution: " + ", ".join(attempted_tools))
    print(json.dumps(description))

def _describe_constructed(trial, bundle, legacy_workflow):
    from autofold_worker.generator_spec import inspect_generator_specs
    generation = None
    kind = "native"
    fresh = bundle.get("freshNative") is True
    try:
        if fresh:
            from proto_language.core import PortfolioProgram
            if isinstance(trial.program, PortfolioProgram):
                trial.program.validate()
                kind = "portfolio"
        if not fresh:
            from autofold_worker.compatibility.proto_portfolio_v1 import ProtoPortfolioProgram
        if not fresh and isinstance(trial.program, ProtoPortfolioProgram):
            kind = "portfolio"
            if trial.search is None:
                generation = trial.program.autofold_generation_plan()
    except (ImportError, ModuleNotFoundError):
        pass
    from autofold_worker.program_inspection import inspect_program as autofold_inspect_program
    program_inspection = autofold_inspect_program(trial.program, kind)
    fresh = bundle.get("freshNative") is True
    if fresh and trial.fixed_control is not None:
        from autofold_worker.program_inspection import describe_fixed
        static = describe_fixed(trial.program, trial.fixed_control, bundle)
    else:
        static = __import__("autofold_worker.program_inspection", fromlist=["inspect_static_construction"]).inspect_static_construction(trial.program, semantic=True) if kind == "native" and program_inspection["generatorCount"] == 0 and trial.intent in {"calibrate", "negative_control"} else None
    description = {
        "generation": generation,
        "nativeSearch": __import__("autofold_worker.native_search", fromlist=["describe_native"]).describe_native(trial.program, trial.search, bundle) if trial.search is not None else None,
        "generatorPreflight": inspect_generator_specs(trial.program),
        "program": program_inspection,
        "diagnostics": trial.autofold_diagnostic_plan(),
        "legacyWorkflow": legacy_workflow,
        "staticConstruction": static,
        "declaration": trial.autofold_declaration(),
        "hypothesis": trial.hypothesis,
    }
    if fresh:
        description["nativeObservation"] = "scoped_native_lifecycle_v1"
        description["executionProtocol"] = "native_search_v1" if trial.search is not None else "native_fixed_control_v1"
        if trial.fixed_control is not None:
            description["nativeFixedControl"] = trial.fixed_control.plan()
    return description

def discover(arguments):
    import json
    import proto_tools
    from proto_tools import ToolRegistry
    from autofold_worker.proto_model_registry import SCIENTIFIC_CATEGORIES, tool_card
    print(json.dumps([
        {
            "key": spec.key,
            "category": spec.category,
            "usesGpu": spec.uses_gpu,
            **({"modelCard": tool_card(spec, ToolRegistry)} if spec.category in SCIENTIFIC_CATEGORIES else {}),
            "numericMetrics": sorted(
                name
                for name, metric in (spec.metrics_model.metric_spec if spec.metrics_model else {}).items()
                if metric.get("type") in {"float", "int"}
            ),
        }
        for spec in ToolRegistry.list_all()
    ]))

def discoverGenerators(arguments):
    import json
    from proto_language.generator import GeneratorRegistry
    from autofold_worker.proto_model_registry import generator_card, component_card
    from proto_language.constraint import ConstraintRegistry
    from proto_language.optimizer import OptimizerRegistry
    try:
        import autofold_worker.proto_generators  # registers optional external generator lanes
    except ModuleNotFoundError as error:
        if error.name != "autofold_worker":
            raise
    print(json.dumps({"components": [component_card(spec, kind) for kind, registry in [("constraint", ConstraintRegistry), ("optimizer", OptimizerRegistry)] for spec in registry.list_all()], "generators": [
        {
            "key": spec.key,
            "label": spec.label,
            "description": spec.description,
            "className": spec.generator_class.__name__,
            "classModule": spec.generator_class.__module__,
            "configName": spec.config_model.__name__,
            "configModule": spec.config_model.__module__,
            "configFields": list(spec.config_model.model_fields),
            "configSchema": spec.config_model.model_json_schema(),
            "allowsEmptyStartingSequence": spec.generator_class.allows_empty_starting_sequence,
            "usesGpu": spec.uses_gpu,
            "toolsCalled": spec.tools_called,
            "modelCard": generator_card(spec),
        }
        for spec in GeneratorRegistry.list_all()
    ]}))

def validateConfigs(arguments):
    import json, sys
    import proto_tools
    from proto_tools import ToolRegistry
    workflow = json.load(sys.stdin)
    for stage in workflow["stages"]:
        for key, config in stage.get("configs", {}).items():
            ToolRegistry.get(key).config_model(**config)

def probe(arguments):
    import json
    print(json.dumps({"format": "autofold.inspection-boundary-probe.v1", "inference": False}))

COMMANDS = {'probe': probe, 'extract': extract, 'describeTrial': describeTrial, 'discover': discover, 'discoverGenerators': discoverGenerators, 'validateConfigs': validateConfigs}

def main():
    if len(sys.argv)<2 or sys.argv[1] not in COMMANDS:
        raise SystemExit("Unknown inspection command")
    import os
    expected = os.environ.get("AUTOFOLD_EXPECTED_PROTO_ROOT")
    if expected and sys.argv[1] not in {"extract", "probe"}:
        from pathlib import Path
        for name, directory in (("proto_language", Path(expected)/"proto_language"), ("proto_tools", Path(expected)/"proto-tools"/"proto_tools")):
            module = __import__(name)
            origin = Path(module.__file__).resolve().parent
            if origin != directory.resolve():
                raise SystemExit("Native inspection imported an unbound package origin: " + name)
    COMMANDS[sys.argv[1]](sys.argv[2:])

if __name__ == "__main__":
    main()
