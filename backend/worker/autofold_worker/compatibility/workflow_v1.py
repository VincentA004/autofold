"""Historical literal workflow binding; original frozen workers retain their bytes."""
from __future__ import annotations
import ast
import hashlib
import json
from pathlib import Path
from typing import Any
from ..protocol import ProtocolError

def validate_workflow_source(path: Path, bundle: dict[str, Any]) -> None:
    """Bind a compiled v4 policy to the literal manifest in immutable trial.py."""
    pipeline = bundle.get("pipeline", {})
    expected = pipeline.get("sourceHash")
    if bundle.get("format") != "autofold.trial-bundle.v4" or not expected:
        return
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    assignments = []
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        if any(isinstance(target, ast.Name) and target.id == "AUTOFOLD_WORKFLOW" for target in targets):
            assignments.append(node)
    if len(assignments) != 1:
        raise ProtocolError("Compiled workflow requires exactly one literal AUTOFOLD_WORKFLOW")
    try:
        workflow = ast.literal_eval(assignments[0].value)
    except (ValueError, TypeError) as error:
        raise ProtocolError("AUTOFOLD_WORKFLOW must be a literal") from error
    if not isinstance(workflow, dict) or not isinstance(workflow.get("stages"), list):
        raise ProtocolError("AUTOFOLD_WORKFLOW must be an object with stages")
    for stage in workflow["stages"]:
        if not isinstance(stage, dict):
            raise ProtocolError("AUTOFOLD_WORKFLOW stages must be objects")
        stage.setdefault("selection", "all")
        stage.setdefault("configs", {})
        stage.setdefault("dependsOn", [])
        stage.setdefault("optional", False)
    canonical = json.dumps(workflow, sort_keys=True, separators=(",", ":"))
    actual = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if actual != expected:
        raise ProtocolError("Compiled pipeline does not match AUTOFOLD_WORKFLOW")

