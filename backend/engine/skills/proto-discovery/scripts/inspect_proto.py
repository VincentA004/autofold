"""Read installed Proto metadata without constructing or running scientific work."""
import argparse
import importlib
import importlib.util
import inspect
import json
from pathlib import Path
import sys


KINDS = {
    "generator": ("proto_language.generator", "GeneratorRegistry", "generator_class"),
    "constraint": ("proto_language.constraint", "ConstraintRegistry", "function"),
    "optimizer": ("proto_language.optimizer", "OptimizerRegistry", "optimizer_class"),
    "tool": ("proto_tools", "ToolRegistry", "function"),
}
FIELDS = (
    "key", "label", "description", "category", "uses_gpu", "input_type",
    "supported_sequence_types", "tools_called", "compatible_generators",
    "required_constraint_mode", "targets_single_segment", "mode", "requires_generators",
)
INSTALLATION_FIELDS = {'device','num_workers','python_executable','executable',
                       'cache_dir','model_path','repo_dir','verbose'}


def registry(kind):
    module, name, _ = KINDS[kind]
    return getattr(importlib.import_module(module), name)


def card(kind, spec):
    return {"kind": kind, **{
        field: getattr(spec, field) for field in FIELDS if hasattr(spec, field)
    }}


def callable_info(value):
    return {
        "symbol": f"{value.__module__}.{value.__qualname__}",
        "signature": str(inspect.signature(value)),
        "source": inspect.getsourcefile(value),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension", action="append", default=[],
                        help="Import an additional local registry extension; bundled model/assessment extensions are already included; no inference")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("environment")
    search = commands.add_parser("search")
    search.add_argument("query", nargs="?", default="")
    search.add_argument("--kind", choices=KINDS)
    search.add_argument("--limit", type=int, default=8)
    describe = commands.add_parser("describe")
    describe.add_argument("kind", choices=KINDS)
    describe.add_argument("key")
    describe.add_argument("--schema", action="store_true", help="Include full config JSON schema")
    describe.add_argument("--operator", action="store_true", help="Include provisioned installation fields in the config schema")
    args = parser.parse_args()
    # Make the shipped bridges visible alongside native tools, without loading
    # model weights or changing Program execution. Explicit imports remain valid.
    extensions = [Path(__file__).with_name(name) for name in
                  ("model_generators.py", "rfd4_redesign.py", "complexa_generator.py", "antibody_generators.py", "local_affinity.py", "ligand_proposals.py")] + args.extension
    imported = set()
    for index, extension in enumerate(extensions):
        extension = Path(extension).resolve(strict=True)
        if extension in imported:
            continue
        imported.add(extension)
        spec = importlib.util.spec_from_file_location(extension.stem, extension)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    if args.command == "environment":
        language = importlib.import_module("proto_language")
        tools = importlib.import_module("proto_tools")
        program = importlib.import_module("proto_language.core").Program
        result = {
            "python": sys.executable,
            "proto_language": language.__file__,
            "proto_tools": tools.__file__,
            "program_run": str(inspect.signature(program.run)),
            "counts": {kind: len(registry(kind).list_all()) for kind in KINDS},
            "note": "Registration is not readiness; no model calls or deployments performed.",
        }
    elif args.command == "search":
        if not 1 <= args.limit <= 50:
            parser.error("--limit must be between 1 and 50")
        terms = args.query.casefold().split()
        matches = []
        for kind in [args.kind] if args.kind else KINDS:
            for spec in registry(kind).list_all():
                item = card(kind, spec)
                haystack = json.dumps(item, default=str).casefold()
                if all(term in haystack for term in terms):
                    matches.append(item)
        matches.sort(key=lambda item: (item["kind"], item["key"]))
        result = {"total_matches": len(matches), "items": matches[:args.limit]}
    else:
        spec = registry(args.kind).get(args.key)
        result = card(args.kind, spec)
        implementation = getattr(spec, KINDS[args.kind][2], None)
        if implementation is not None:
            result["implementation"] = callable_info(implementation)
        result["config"] = callable_info(spec.config_model)
        schema = spec.config_model.model_json_schema()
        hidden = INSTALLATION_FIELDS - set(schema.get('required', []))
        if not args.operator:
            signature = inspect.signature(spec.config_model)
            result['config']['signature'] = str(signature.replace(parameters=[
                p for name,p in signature.parameters.items() if name not in hidden]))
        if args.schema:
            result["config_schema"] = schema
            if not args.operator:
                # Required fields stay visible until the adapter can provision them.
                for field in hidden:
                    schema.get('properties', {}).pop(field, None)
        if args.kind == "tool":
            result["input"] = callable_info(spec.input_model)
            result["output"] = callable_info(spec.output_model)
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    try:
        main()
    except (ImportError, ValueError, AttributeError) as error:
        print(f"Proto inspection failed: {error}", file=sys.stderr)
        sys.exit(1)
