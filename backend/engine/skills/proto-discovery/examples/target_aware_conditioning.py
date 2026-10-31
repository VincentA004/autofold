"""Native cycling handoff example; model-backed behavior needs its own smoke test.

Copy beside a trial program and use functools.partial to bind the fixed target,
selected predictor and explicit tool configuration. No calls occur on import.
"""
from proto_language.core import Sequence
from proto_tools import Chain, Complex, InverseFoldingStructureInput, predict_structures


def condition_on_target(
    sequences: list[Sequence],
    *,
    target_sequence: str,
    structure_tool: str,
    tool_config: dict,
    target_chain_id: str = "A",
    binder_chain_id: str = "B",
    fixed_binder_positions: list[int] | None = None,
) -> list[InverseFoldingStructureInput]:
    """Predict target/binder complexes and request binder-only inverse folding.

    Target sequence and returned chain mapping are checked. Target coordinates,
    chemical modifications and epitope restraints are not specified by this example.
    Configured structural filters still need to evaluate the redesigned proposals.
    """
    if not target_sequence or not sequences or any(not seq.sequence for seq in sequences):
        raise ValueError("Provide a nonempty target and starting binder sequences.")
    if not target_chain_id or not binder_chain_id or target_chain_id == binder_chain_id:
        raise ValueError("Target and binder need distinct explicit chain IDs.")
    complexes = [
        Complex(chains=[
            Chain(id=target_chain_id, sequence=target_sequence, entity_type="protein"),
            Chain(id=binder_chain_id, sequence=seq.sequence, entity_type="protein"),
        ])
        for seq in sequences
    ]
    prediction = predict_structures(complexes, structure_tool, dict(tool_config))
    if not prediction.success:
        raise RuntimeError("Complex prediction failed; inspect its original diagnostic output.")
    structures = prediction.structures
    if len(structures) != len(sequences):
        raise ValueError("Expected one predicted complex per binder; choose sample handling explicitly.")
    conditioning = []
    for sequence, structure in zip(sequences, structures, strict=True):
        expected = {target_chain_id: target_sequence, binder_chain_id: sequence.sequence}
        observed = structure.get_chain_sequences()
        if observed != expected:
            raise ValueError("Predicted chains differ from the target/binder mapping; inspect before remapping.")
        conditioning.append(InverseFoldingStructureInput(
            structure=structure,
            chains_to_redesign=[binder_chain_id],
            fixed_positions=(
                {binder_chain_id: fixed_binder_positions} if fixed_binder_positions else None
            ),
        ))
    return conditioning
