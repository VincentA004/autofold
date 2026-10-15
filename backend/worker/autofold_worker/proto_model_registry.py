"""Read-only scientific metadata projected from native Proto registries.

No dispatch, environment initialization, model import, download or asset probing.
The pinned ToolRegistry remains the authority for executable tools. Native input
schema features and this worker's adapter features are deliberately separate.
"""
from __future__ import annotations

from typing import Any

SCIENTIFIC_CATEGORIES = {
    "structure_prediction", "structure_design", "sequence_design",
    "inverse_folding", "protein_embedding", "sequence_embedding",
    "protein_generation", "sequence_generation", "binding_affinity",
    "binder_design", "masked_models", "sequence_scoring", "structure_scoring", "structure_dynamics", "mutagenesis",
}
FEATURES = ("protein_sequences", "complex_sequences", "cyclic_bonds", "disulfide_bonds", "modified_residues", "glycans", "msa_artifacts", "structure_templates")


def public_schema(model: Any) -> dict[str, Any] | None:
    if model is None or not hasattr(model, "model_json_schema"):
        return None
    # Public schema only. Defaults/examples may contain runtime paths or ambient
    # credentials in third-party config classes; never serialize those values.
    def clean(value: Any) -> Any:
        if isinstance(value, dict):
            return {str(k): clean(v) for k, v in value.items() if k not in {"default", "examples", "example"}}
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value if value is None or isinstance(value, (str, bool, int, float)) else None
    return clean(model.model_json_schema())


def schema_fields(schema: dict[str, Any] | None) -> list[str]:
    return sorted((schema or {}).get("properties", {}))


def declared_features(schema: dict[str, Any] | None) -> dict[str, bool | None]:
    fields = set(schema_fields(schema))
    names: set[str] = set()
    def visit(value: Any) -> None:
        if isinstance(value, dict):
            names.update(value.get("properties", {}))
            for item in value.values():
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    visit(schema)
    # Presence is a schema declaration, not validation of model accuracy or
    # chemical behavior. Absence stays unknown instead of inventing support.
    return {
        "protein_sequences": True if fields.intersection({"sequences", "complexes"}) else None,
        "complex_sequences": True if "complexes" in fields else None,
        "cyclic_bonds": True if names.intersection({"cyclic", "cyclic_bonds"}) else None,
        "disulfide_bonds": True if names.intersection({"disulfide_bonds", "disulfides"}) else None,
        "modified_residues": True if names.intersection({"modifications", "modified_residues"}) else None,
        "glycans": True if names.intersection({"glycan", "glycans"}) else None,
        "msa_artifacts": True if fields.intersection({"msas", "msa", "msa_paths"}) else None,
        "structure_templates": True if fields.intersection({"templates", "template", "template_paths"}) else None,
    }


def _metrics(spec: Any) -> list[dict[str, Any]]:
    model = getattr(spec, "metrics_model", None)
    result = []
    for name, metric in sorted((getattr(model, "metric_spec", None) or {}).items()):
        if not isinstance(metric, dict):
            continue
        result.append({"name": name, "type": str(metric.get("type", "unknown")),
                       "description": str(metric.get("description", "")),
                       "unit": str(metric["unit"]) if metric.get("unit") is not None else None,
                       "direction": str(metric["better_values_are"]) if metric.get("better_values_are") is not None else None})
    return result


def bridge_features(spec: Any) -> dict[str, bool | None]:
    features = {name: None for name in FEATURES}
    if spec.category == "structure_prediction":
        features = {name: False for name in FEATURES}
        model = getattr(spec, "input_model", None)
        entities = set(getattr(model, "SUPPORTED_ENTITY_TYPES", ()) or ())
        if "complexes" in schema_fields(public_schema(model)):
            # The scoring adapter constructs protein chains. A generic complex
            # schema on an RNA-only tool cannot establish protein support.
            supports_protein = "protein" in entities if entities else None
            features["protein_sequences"] = supports_protein
            features["complex_sequences"] = supports_protein
    return features


def assert_input_requirements(spec: Any, features: Any) -> None:
    if not isinstance(features, (list, tuple)) or any(not isinstance(item, str) or item not in FEATURES for item in features) or len(set(features)) != len(features):
        raise ValueError("Invalid required Proto model input features")
    supported = bridge_features(spec)
    missing = [feature for feature in features if supported[feature] is not True]
    if missing:
        raise ValueError(f"Proto model {spec.key} adapter cannot preserve required inputs: {', '.join(missing)}")


def tool_card(spec: Any, registry: Any) -> dict[str, Any]:
    schema = public_schema(getattr(spec, "input_model", None))
    config = public_schema(getattr(spec, "config_model", None))
    output = public_schema(getattr(spec, "output_model", None))
    category = str(spec.category)
    roles = {
        "structure_prediction": ["structure_prediction"],
        "structure_design": ["structure_generation"],
        "sequence_design": ["inverse_folding"], "inverse_folding": ["inverse_folding"],
        "protein_embedding": ["sequence_representation"], "sequence_embedding": ["sequence_representation"],
        "protein_generation": ["sequence_generation"], "sequence_generation": ["sequence_generation"],
        "binding_affinity": ["affinity_prediction"], "binder_design": ["candidate_generation"],
        "masked_models": ["sequence_representation", "masked_sequence_generation"],
        "sequence_scoring": ["sequence_scoring"], "structure_scoring": ["structure_scoring"],
        "structure_dynamics": ["structure_dynamics"], "mutagenesis": ["sequence_design"],
    }.get(category, ["unknown"])
    if category == "structure_prediction" and "complexes" in schema_fields(schema):
        roles.append("complex_prediction")
    if spec.key == "boltz2-affinity":
        roles = ["small_molecule_affinity_prediction"]
    bridge = bridge_features(spec)
    entities = sorted(getattr(getattr(spec, "input_model", None), "SUPPORTED_ENTITY_TYPES", ()) or ())
    native = declared_features(schema)
    if entities and "protein" not in entities:
        native["protein_sequences"] = False
    notes = ["Registry registration does not verify cached weights, checkpoint license, scientific calibration or hardware fit."]
    if category == "structure_prediction":
        notes.append("Structure confidence is not a measured binding affinity. Current scoring bridge supplies protein sequences only; explicit chemistry, MSAs and templates are not preserved.")
    if spec.key == "boltz2-affinity":
        notes.append("Native affinity head predicts small-molecule/protein affinity; it is not a calibrated peptide/protein binding scorer. The sequence-only scoring bridge does not supply its ligand input.")
    if spec.key == "protenix-prediction":
        notes.append("Protenix v2 has version-specific weight restrictions. Generic toolkit license declarations do not establish rights for the selected checkpoint.")
    if "esmfold" in spec.key:
        notes.append("Verify the exact ESMFold generation and complex/chemistry coverage; a short peptide's monomer confidence is not a binding criterion.")
    def declaration(method: str) -> dict[str, Any] | None:
        fn = getattr(registry, method, None)
        value = fn(spec.key) if callable(fn) else None
        return value if isinstance(value, dict) else None
    return {
        "format": "autofold.proto-model-card.v1", "key": spec.key, "kind": "tool",
        "label": str(getattr(spec, "label", spec.key)), "category": category,
        "description": str(getattr(spec, "description", "")), "roles": roles,
        "registration": "registered", "assetReadiness": "unknown",
        "usesGpu": bool(spec.uses_gpu), "deviceCount": str(getattr(spec, "device_count", "unknown")),
        "inputSchema": schema, "configSchema": config, "outputSchema": output,
        "inputFields": schema_fields(schema), "configFields": schema_fields(config),
        "supportedEntityTypes": entities,
        "nativeFeatures": native, "bridgeFeatures": bridge,
        "metrics": _metrics(spec), "seedFields": [name for name in schema_fields(config) if name in {"seed", "seeds"}],
        "licenseDeclaration": declaration("get_license"), "weightLicenseStatus": "unverified",
        "links": declaration("get_links"), "resourceProfile": None, "limitations": notes,
    }


def generator_card(spec: Any) -> dict[str, Any]:
    config = public_schema(getattr(spec, "config_model", None))
    return {
        "format": "autofold.proto-model-card.v1", "key": spec.key, "kind": "generator",
        "label": str(getattr(spec, "label", spec.key)), "category": "generator",
        "description": str(getattr(spec, "description", "")), "roles": ["candidate_generation"],
        "registration": "registered", "assetReadiness": "unknown", "usesGpu": bool(spec.uses_gpu),
        "deviceCount": "unknown", "inputSchema": None, "configSchema": config, "outputSchema": None,
        "inputFields": [], "configFields": schema_fields(config), "supportedEntityTypes": [],
        "nativeFeatures": {name: None for name in FEATURES}, "bridgeFeatures": {name: None for name in FEATURES},
        "metrics": [], "seedFields": [name for name in schema_fields(config) if name in {"seed", "seeds"}],
        "licenseDeclaration": None, "weightLicenseStatus": "unverified", "links": None, "resourceProfile": None,
        "toolsCalled": list(getattr(spec, "tools_called", [])),
        "limitations": ["Generator registration does not establish model assets or inference readiness. Native configuration schema owns design options; seed fields alone do not prove upstream RNG control."],
    }


def component_card(spec: Any, kind: str) -> dict[str, Any]:
    """Native objective/optimizer metadata; never instantiate or evaluate it."""
    card = generator_card(spec)
    card.update(kind=kind, category=str(getattr(spec, "category", None) or kind),
        roles=["objective_and_filter" if kind == "constraint" else "scientific_search"],
        supportedEntityTypes=list(getattr(spec, "supported_sequence_types", [])),
        semantics={"scoreDirection": "lower_penalty" if kind == "constraint" else None,
            "mode": getattr(spec, "mode", None),
            "compatibleGenerators": getattr(spec, "compatible_generators", None),
            "requiredConstraintMode": getattr(spec, "required_constraint_mode", None),
            "targetsSingleSegment": getattr(spec, "targets_single_segment", None),
            "backwardConfigSchema": public_schema(getattr(spec, "backward_config_model", None))},
        limitations=["Native registration is not readiness or scientific validation. Objective penalties are computational proxies; preserve raw metrics, units, missing values and final independent evaluation."])
    return card
