/** Independently authored CPU plumbing fixture, not a production template/oracle. */
export function cpuTrial(input: {experimentId: string; ordinal: number; evidenceRefs: string[]; workerJournalPath: string}) {
  const declaration = {
    question: 'Does an independently supervised native CPU draw produce a recoverable result?',
    changedVariables: ['Independent draw ' + input.ordinal],
    controlledVariables: ['Frozen mock evaluator', 'Zero GPU allowance'],
    alternatives: [
      {id: 'draw', experiment: 'Draw a native CPU random peptide', expectedInformation: 'An independently receipted plumbing observation', estimatedGpuHours: 0},
      {id: 'inspect', experiment: 'Inspect prior observations only', expectedInformation: 'No additional execution', estimatedGpuHours: 0},
    ],
    selectedAlternativeId: 'draw', rationale: 'Exercise process interruption and continuation without biological claims.',
    evidenceRefs: input.evidenceRefs.length ? input.evidenceRefs : [input.experimentId],
    replicationPurpose: 'A second independent execution tests continued ownership after the prior receipt is recovered.',
    outcomeBranches: [
      {observation: 'A complete valid receipt is available', nextDecision: 'Retain its original identity and continue within the grant'},
      {observation: 'The receipt is incomplete or ambiguous', nextDecision: 'Hold without duplicating execution'},
    ],
  }
  return `"""CPU infrastructure acceptance fixture; no learned model, GPU, or biological claim."""
import json
import time
import os
from datetime import datetime, timezone
from contextlib import nullcontext
from proto_language.constraint.protein_quality import protein_diversity_constraint
from proto_language.constraint.protein_quality.protein_diversity_constraint import ProteinDiversityConfig
from proto_language.core import Constraint, Construct, Program, Segment
from proto_language.generator import RandomProteinGenerator, RandomProteinGeneratorConfig
from proto_language.optimizer import RejectionSamplingOptimizer, RejectionSamplingOptimizerConfig
from autofold_worker.proto_trial import ProtoTrial, NativeSearch, NativeOutput

# Inspection constructs this context but never enters it. Only genuine Program.run
# pauses, leaving enough time for the external fault injector to stop the server.
class ObservableCPUExecution(nullcontext):
    def __init__(self, run_id):
        super().__init__()
        self.run_id = run_id
        self.depth = 0

    def __enter__(self):
        self.depth += 1
        if self.depth > 1:
            return self
        # Test-owned independent journal is append-only and fsynced BEFORE the
        # genuine native run. It cannot be produced by receipt reconciliation.
        run_id = self.run_id
        if not isinstance(run_id, str) or not run_id.startswith("run_"):
            raise ValueError("Actual native execution has no frozen run identity")
        def record(event):
            row = {"event": event, "runId": run_id, "pid": os.getpid(), "at": datetime.now(timezone.utc).isoformat()}
            fd = os.open(${JSON.stringify(input.workerJournalPath)}, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.write(fd, (json.dumps(row) + "\\n").encode())
                os.fsync(fd)
            finally:
                os.close(fd)
        record("worker_start")
        time.sleep(8)
        return self

    def __exit__(self, *exc):
        self.depth -= 1
        return False

def build_trial(ctx):
    peptide = Segment(length=24, sequence_type="protein", label="designed-peptide")
    generator = RandomProteinGenerator(RandomProteinGeneratorConfig())
    generator.assign(peptide)
    constraint = Constraint(inputs=[peptide], function=protein_diversity_constraint,
        function_config=ProteinDiversityConfig(min_diversity=0.2))
    count = min(ctx.submission_size, ctx.candidate_budget)
    optimizer = RejectionSamplingOptimizer(constructs=[Construct([peptide], label="candidate")],
        generators=[generator], constraints=[constraint],
        config=RejectionSamplingOptimizerConfig(num_samples=ctx.candidate_budget,
            num_results=count, proposal_batch_size=min(4, ctx.candidate_budget)))
    program = Program(optimizers=[optimizer], num_results=count,
        seed=ctx.generation_seed, compute=ObservableCPUExecution(ctx.get("runId")))
    plan = json.loads(${JSON.stringify(JSON.stringify(declaration))})
    return ProtoTrial(program=program,
        hypothesis="CPU infrastructure draw ${input.ordinal} should preserve an attributable frozen-panel observation",
        intent="optimize", decision_plan=plan, evidence_refs=tuple(plan["evidenceRefs"]),
        search=NativeSearch(maximum_candidates=count, maximum_proposals=ctx.candidate_budget,
            maximum_sampling_calls=ctx.candidate_budget, maximum_tool_calls=ctx.candidate_budget,
            maximum_wall_seconds=30, outputs=(NativeOutput(construct="candidate"),),
            allowed_tools=("random-protein-sample",)))
`
}
