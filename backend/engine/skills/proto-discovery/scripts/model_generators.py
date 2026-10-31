"""Optional native Proto generators for independently installed biological models.

Import this module before registry inspection or Program construction. No model is
loaded on import. Copy it into the captured program bundle when executing a trial.
"""
import json
import hashlib
import os
from pathlib import Path
import re
import subprocess
from typing import Literal

import yaml

from proto_language.core import Generator, GeneratorInputType, Sequence
from proto_language.generator.generator_registry import generator
from proto_language.utils.base import BaseConfig, ConfigField
from proto_tools.entities.structures import Structure


def read_designs(directory: Path, binder_chain: str, length: int):
    """Read one explicit output stage; never substitute target/other chains."""
    paths = sorted(directory.glob("*.cif"))
    if not paths:
        raise ValueError(f"No generated CIFs in {directory}")
    designs = []
    for path in paths:
        structure = Structure(structure=path.read_text())
        chains = structure.get_chain_sequences()
        if binder_chain not in chains:
            raise ValueError(f"Binder chain {binder_chain!r} absent from {path}; chains={list(chains)}")
        sequence = chains[binder_chain]
        if len(sequence) != length or set(sequence) - set("ACDEFGHIKLMNPQRSTVWY"):
            raise ValueError(f"Unexpected binder sequence/length in {path}: {sequence!r}")
        designs.append((path, structure, sequence))
    return designs


class BoltzGenBinderConfig(BaseConfig):
    design_spec: str = ConfigField(title="Design specification", description="Existing native YAML; file references are relative to that YAML. Declare it and referenced structures as trial inputs.")
    binder_chain: str = ConfigField(title="Output binder chain", description="Exact chain ID in native generated CIFs; verify against native design metadata, never infer by length.")
    output_dir: str = ConfigField(title="Evidence directory", description="Persistent directory inside trial output; every invocation gets a fresh numbered subdirectory.")
    protocol: Literal["peptide-anything", "protein-anything"] = ConfigField(default="peptide-anything", title="Design protocol", description="Match the molecular class: peptide or folded protein. This bridge runs design + inverse-folding only; assess standalone folding and target binding separately.")
    executable: str = ConfigField(default_factory=lambda: os.environ.get("AUTOFOLD_BOLTZGEN_EXECUTABLE", "boltzgen"), title="Executable", description="Selected installed BoltzGen CLI")
    cache_dir: str = ConfigField(default_factory=lambda: os.environ.get("AUTOFOLD_BOLTZGEN_CACHE", ""), title="Cache", description="Selected model cache")
    timeout_seconds: int = ConfigField(default=900, ge=1, title="Invocation timeout", description="Seconds, bounded by remaining trial/campaign budget")


@generator(key="boltzgen-binder", label="BoltzGen target-conditioned design",
           config=BoltzGenBinderConfig, uses_gpu=True, tools_called=[],
           supported_sequence_types=["protein"],
           description="Generate target-conditioned peptide or protein backbones and sequences using installed BoltzGen design + inverse-folding stages. Native YAML owns conditioning. Preserves all CLI outputs; does not predict binding affinity.")
class BoltzGenBinderGenerator(Generator):
    input_type = GeneratorInputType.STARTING_SEQUENCE
    allows_empty_starting_sequence = True

    def __init__(self, config: BoltzGenBinderConfig):
        super().__init__()
        self.config = config

    def _preserve_structure_after_sample(self):
        return True

    def _sample(self):
        spec = Path(self.config.design_spec).resolve(strict=True)
        if not self.config.cache_dir or not Path(self.config.cache_dir).is_dir():
            raise ValueError("Select an existing BoltzGen cache explicitly")
        root = Path(self.config.output_dir).resolve()
        root.mkdir(parents=True, exist_ok=True)
        number = 1
        while (root / f"call-{number:03}").exists():
            number += 1
        capture = root / f"call-{number:03}"
        capture.mkdir()  # Existing outputs are never reused or replaced.
        count = self.segment.num_proposals
        output = capture / "native"
        command = [self.config.executable, "run", str(spec), "--output", str(output),
                   "--protocol", self.config.protocol, "--num_designs", str(count),
                   "--diffusion_batch_size", "1", "--devices", "1", "--num_workers", "0",
                   "--no_subprocess",
                   "--cache", self.config.cache_dir, "--steps", "design", "inverse_folding"]
        receipt = {"command": command, "requested_designs": count,
                   "seed_control": "not exposed by selected CLI; Program seed does not control model RNG"}
        (capture / "request.json").write_text(json.dumps(receipt, indent=2) + "\n")
        (capture / "design-spec.yaml").write_bytes(spec.read_bytes())
        try:
            with (capture / "stdout.log").open("w") as stdout, (capture / "stderr.log").open("w") as stderr:
                result = subprocess.run(command, stdout=stdout, stderr=stderr,
                                        timeout=self.config.timeout_seconds, check=True)
            receipt["returncode"] = result.returncode
            # This is the installed pipeline's sequence-redesigned output stage.
            designs = read_designs(output / "intermediate_designs_inverse_folded",
                                   self.config.binder_chain, self.segment.sequence_length)
            if len(designs) != count:
                raise ValueError(f"Requested {count} designs; received {len(designs)}; inspect preserved outputs")
            proposals = []
            for path, structure, sequence in designs:
                proposal = Sequence(sequence=sequence, sequence_type="protein", structure=structure)
                proposal._generator_metadata[self._spec.key] = {
                    "artifact": str(path), "binder_chain": self.config.binder_chain,
                    "request": str(capture / "request.json"), "seed_control": receipt["seed_control"]}
                proposals.append(proposal)
            self.segment.proposal_sequences = proposals
            receipt["returned_designs"] = len(proposals)
        except Exception as error:
            receipt["error"] = str(error)
            raise
        finally:
            (capture / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


def rfd4_local_search(path, requested):
    """Validate our bounded local-only bridge; native RFD4 owns search/rewards.

    Interior checkpoints finish as native bsfinal outputs, making final beams
    distinguishable from the completed scoring rollouts we also retain.
    """
    document = yaml.safe_load(Path(path).read_text())
    if not isinstance(document, dict) or set(document) != {"metrics", "search"}:
        raise ValueError("Search specification must contain only native metrics and search blocks")
    metrics = document["metrics"]
    if not isinstance(metrics, dict) or set(metrics) != {"inline_metrics"}:
        raise ValueError("Local search supports inline_metrics only; refolding/oracle services are not exposed")
    providers = metrics["inline_metrics"]
    allowed = {
        "rfproteina.metrics.interaction_metrics.InterchainInteractionMetric",
        "rfproteina.metrics.design_metrics.ClashMetric",
        "rfproteina.metrics.design_metrics.BondLengthMetric",
        "rfproteina.metrics.hotspots.HotspotObedience",
    }
    if not isinstance(providers, dict) or not providers:
        raise ValueError("Declare local structural metric providers explicitly")
    for name, provider in providers.items():
        if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
                or not isinstance(provider, dict) or provider.get("_target_") not in allowed):
            raise ValueError("Unsupported local metric provider; no external oracle or custom service fallback")
        # Do not let nested Hydra factories introduce undeclared runtimes.
        if any(isinstance(v, dict) for v in provider.values()):
            raise ValueError("Nested metric factories are not supported by this local bridge")
    search = document["search"]
    if not isinstance(search, dict) or set(search) - {"beam_width", "n_branch", "checkpoints", "save_rollouts", "save_states"}:
        raise ValueError("Unsupported search fields; resume, continuation and final-checkpoint selection are not exposed")
    for key in ("beam_width", "n_branch"):
        if type(search.get(key)) is not int or search[key] < 1:
            raise ValueError(f"search.{key} must be a positive integer")
    if requested % search["beam_width"]:
        raise ValueError("Proto proposal count must be a multiple of native beam_width")
    checkpoints = search.get("checkpoints")
    if not isinstance(checkpoints, dict) or not checkpoints:
        raise ValueError("Specify at least one interior checkpoint in the fixed 60-step schedule")
    for step, checkpoint in checkpoints.items():
        if (isinstance(step, bool) or not str(step).isdigit() or not 0 < int(step) < 60
                or not isinstance(checkpoint, dict)
                or set(checkpoint) - {"metrics", "rewards", "n_branch", "use_clean_prediction"}):
            raise ValueError("Only interior checkpoints 1..59 with explicit native metrics/rewards are supported")
        names = checkpoint.get("metrics")
        if not isinstance(names, list) or not names or any(name not in providers for name in names):
            raise ValueError("Each checkpoint must select declared local providers explicitly")
        rewards = checkpoint.get("rewards")
        if not isinstance(rewards, dict) or not rewards or any(not isinstance(key, str) or key.split(".")[0] not in names for key in rewards):
            raise ValueError("Reward outputs must come from the checkpoint's selected providers")
        if "use_clean_prediction" in checkpoint and type(checkpoint["use_clean_prediction"]) is not bool:
            raise ValueError("use_clean_prediction must be boolean")
        if "n_branch" in checkpoint and (type(checkpoint["n_branch"]) is not int or checkpoint["n_branch"] < 1):
            raise ValueError("Checkpoint n_branch must be a positive integer")
    for key in ("save_rollouts", "save_states"):
        if key in search and search[key] is not True:
            raise ValueError("Local guided search retains all completed rollouts and selected sampling states")
        search[key] = True
    return document


class RFD4BinderConfig(BaseConfig):
    design_spec: str = ConfigField(title="Condition specification", description="Native YAML/JSON with exactly one design example; referenced structures are relative to this file. Declare all as trial inputs.")
    binder_chain: str = ConfigField(title="Output binder chain", description="Exact output chain verified in a one-design preflight, not inferred from length.")
    target_chain: str = ConfigField(title="Output target chain", description="Exact preserved target chain in generated output.")
    target_sequence: str = ConfigField(title="Target sequence", description="Expected complete protein target sequence; each output must preserve its identity.")
    output_dir: str = ConfigField(title="Evidence directory", description="Inside trial output; each invocation creates a fresh numbered capture.")
    model_path: str = ConfigField(default_factory=lambda: os.environ.get("AUTOFOLD_RFD4_MODEL", ""), title="Pinned model bundle", description="Existing local directory containing config.json and model.safetensors; no download or install is performed by this adapter.")
    executable: str = ConfigField(default_factory=lambda: os.environ.get("AUTOFOLD_RFD4_EXECUTABLE", "rfd4-generate"), title="Executable", description="Installed native RFD4 CLI in its own environment.")
    thinking: Literal["low", "medium", "high"] = ConfigField(default="medium", title="Recycle schedule", description="Native thinking preset; generation compute, not an affinity objective or reward-guided search.")
    mode: Literal["generation", "guided_search"] = ConfigField(default="generation", title="Generation mode", description="Plain generation by default; optional local structural reward-guided beam search.")
    search_spec: str | None = ConfigField(default=None, title="Native local search specification", description="Captured YAML with native search and metrics.inline_metrics. Required only for guided_search; no external oracles. Interior checkpoints in a 60-step schedule; all final beams become Proto proposals.")
    timeout_seconds: int = ConfigField(default=900, ge=1, title="Invocation timeout", description="Bound by remaining campaign time.")


@generator(key="rfd4-binder", label="RFD4-Proteina target-conditioned design",
           config=RFD4BinderConfig, uses_gpu=True, tools_called=[],
           supported_sequence_types=["protein"],
           description="Generate sequences and all-atom binder structures jointly with installed local RFD4. Optional native structural reward-guided search; preserves beams, completed scoring rollouts and states. No external oracle or affinity claim.")
class RFD4BinderGenerator(Generator):
    input_type = GeneratorInputType.STARTING_SEQUENCE
    allows_empty_starting_sequence = True

    def __init__(self, config: RFD4BinderConfig):
        super().__init__()
        self.config = config

    def _preserve_structure_after_sample(self):
        return True

    def _native_overrides(self):
        return []

    def _runtime_overrides(self):
        profile = os.environ.get('AUTOFOLD_RUNTIME_PROFILE')
        route = json.loads(Path(profile).read_text()).get('rfd4',{'backend':'native'}) if profile else {'backend':'native'}
        operation = getattr(self.config,'operation','generation')
        if operation=='inverse_folding':
            self._execution_backend = 'native-autoencoder'
            return []  # No velocity-network sampling occurs in inverse folding.
        self._execution_backend = route['backend']
        if route['backend']=='native':return []
        if self.config.mode=='guided_search':
            raise ValueError('Guided search is not qualified for the pinned BioIR RFD4 route')
        return ['inference_backend=bioir','bioir.cuda_graph=false','bioir.match_reference_rng=true']

    def _validate_proposal(self, structure, sequence):
        pass

    def _sample(self):
        spec = Path(self.config.design_spec).resolve(strict=True)
        examples = yaml.safe_load(spec.read_text())
        if (not isinstance(examples, dict)
                or len([key for key in examples if key != "global_args"]) != 1):
            raise ValueError("RFD4 adapter requires exactly one design example per specification")
        if self.config.binder_chain == self.config.target_chain:
            raise ValueError("Binder and target chain IDs must differ")
        if not self.config.target_sequence or set(self.config.target_sequence) - set("ACDEFGHIKLMNPQRSTVWY"):
            raise ValueError("Expected a complete canonical protein target sequence")
        if not self.config.model_path:
            raise ValueError("Select an existing pinned RFD4 model bundle explicitly")
        model = Path(self.config.model_path).resolve(strict=True)
        if not all((model / name).is_file() for name in ("config.json", "model.safetensors")):
            raise ValueError("RFD4 model bundle must contain config.json and model.safetensors")
        count = self.segment.num_proposals
        if self.config.mode == "guided_search":
            if not self.config.search_spec:
                raise ValueError("guided_search requires an explicit captured search_spec")
            search_path = Path(self.config.search_spec).resolve(strict=True)
            search_document = rfd4_local_search(search_path, count)
            beam_width = search_document["search"]["beam_width"]
        else:
            if self.config.search_spec is not None:
                raise ValueError("search_spec is only used in guided_search mode")
            search_document, beam_width = None, 1
        root = Path(self.config.output_dir).resolve()
        root.mkdir(parents=True, exist_ok=True)
        number = 1
        while (root / f"rfd4-call-{number:03}").exists():
            number += 1
        capture = root / f"rfd4-call-{number:03}"
        capture.mkdir()
        seed = self._next_seed()
        output = capture / "native"
        command = [self.config.executable, f"inputs={spec}", f"out_dir={output}",
                   f"hf_ckpt_path={model}", "hf_ckpt_revision=null",
                   f"num_replicates={count // beam_width}", "batch_size=1", "num_workers=0",
                   "compile_lengths=null", f"recycle_strategy=thinking_{self.config.thinking}",
                   "prevalidate_inputs=true", "skip_existing=false",
                   "compress_outputs=false", f"hydra.run.dir={capture / 'hydra'}"]
        if search_document is None:
            command.append("~metrics")
        else:
            local = capture / "config"
            (local / "metrics").mkdir(parents=True)
            (local / "autofold_guidance").mkdir()
            local_metrics = {"inline_metrics": search_document["metrics"]["inline_metrics"],
                             **{key: None for key in ("refolding_oracles", "refolding_metrics", "pass_criteria", "pre_oracle_filters")}}
            (local / "metrics/autofold_local.yaml").write_text(yaml.safe_dump(local_metrics))
            (local / "autofold_guidance/search.yaml").write_text(yaml.safe_dump({"search": search_document["search"]}))
            (capture / "search-spec.yaml").write_bytes(search_path.read_bytes())
            (capture / "effective-search.yaml").write_text(yaml.safe_dump(search_document))
            # Hydra's positional override parser requires options before overrides.
            command = [command[0], "--config-dir", str(local), *command[1:]]
            command += ["metrics=autofold_local",
                        "+autofold_guidance@_global_=search", "generation.args.nsteps=60",
                        "metrics_tags=[]", "delete_failing_pre_oracle=false"]
        if seed is not None:
            command.append(f"seed={seed}")
        command.extend(self._runtime_overrides())
        command.extend(self._native_overrides())
        receipt = {"command": command, "requested_designs": count, "seed": seed,
                   "execution_backend": self._execution_backend,
                   "seed_control": "advancing native Program seed stream; unseeded when Program has no seed",
                   "model_path": str(model), "mode": self.config.mode,
                   "native_replicates": count // beam_width, "beam_width": beam_width,
                   "search_spec_sha256": hashlib.sha256(search_path.read_bytes()).hexdigest() if search_document else None,
                   "search_scope": "local structural metrics only; not a binding-affinity reward" if search_document else None}
        (capture / "request.json").write_text(json.dumps(receipt, indent=2) + "\n")
        (capture / "design-spec.yaml").write_bytes(spec.read_bytes())
        try:
            with (capture / "stdout.log").open("w") as stdout, (capture / "stderr.log").open("w") as stderr:
                result = subprocess.run(command, stdout=stdout, stderr=stderr,
                                        timeout=self.config.timeout_seconds, check=True,
                                        env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                                             "HF_HUB_DISABLE_TELEMETRY": "1", "AWS_EC2_METADATA_DISABLED": "true"})
            receipt["returncode"] = result.returncode
            all_paths = sorted((output / "inference_samples").rglob("*_generated.cif"))
            paths = ([p for p in all_paths if re.search(r"_bsfinal_\d+_generated\.cif$", p.name)]
                     if search_document else all_paths)
            inventory = [{"path": str(p.relative_to(capture)),
                          "role": "final_beam" if p in paths else "scoring_rollout",
                          "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in all_paths]
            (capture / "outputs.json").write_text(json.dumps(inventory, indent=2) + "\n")
            receipt["scoring_rollouts"] = len(all_paths) - len(paths)
            if len(paths) != count:
                raise ValueError(f"Requested {count} RFD4 designs; received {len(paths)}; inspect preserved outputs")
            proposals = []
            for path in paths:
                structure = Structure(structure=path.read_text())
                chains = structure.get_chain_sequences()
                if chains.get(self.config.target_chain) != self.config.target_sequence:
                    raise ValueError(f"Generated target identity mismatch in {path}; chains={list(chains)}")
                sequence = chains.get(self.config.binder_chain, "")
                if len(sequence) != self.segment.sequence_length or set(sequence) - set("ACDEFGHIKLMNPQRSTVWY"):
                    raise ValueError(f"Unexpected RFD4 binder chain/sequence/length in {path}; chains={list(chains)}")
                self._validate_proposal(structure, sequence)
                proposal = Sequence(sequence=sequence, sequence_type="protein", structure=structure)
                proposal._generator_metadata[self._spec.key] = {
                    "artifact": str(path), "binder_chain": self.config.binder_chain,
                    "target_chain": self.config.target_chain, "request": str(capture / "request.json"),
                    "seed": seed, "mode": self.config.mode, "beam_width": beam_width}
                proposals.append(proposal)
            self.segment.proposal_sequences = proposals
            receipt["returned_designs"] = len(proposals)
        except Exception as error:
            receipt["error"] = str(error)
            raise
        finally:
            (capture / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
