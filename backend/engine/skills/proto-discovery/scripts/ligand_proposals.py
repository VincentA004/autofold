"""CPU RDKit analog proposals inside native Proto; no models or installations.

Requires the operator-applied proto-ligand-proposals.patch. Capture this module
with the Program. Reaction SMARTS describe graph edits, not synthesis guarantees.
"""
import json
from pathlib import Path
import random
import uuid

from pydantic import BaseModel, Field
from rdkit import Chem
from rdkit.Chem import rdChemReactions
from proto_language.core import Generator, GeneratorInputType, Sequence
from proto_language.generator.generator_registry import generator
from proto_language.utils.base import BaseConfig, ConfigField


def write(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def molecule(smiles):
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError('Invalid ligand SMILES')
    if len(Chem.GetMolFrags(mol)) != 1 or any(a.GetNumRadicalElectrons() for a in mol.GetAtoms()):
        raise ValueError('Expected one connected, closed-shell ligand')
    if any(s.specified == Chem.StereoSpecified.Unspecified for s in Chem.FindPotentialStereo(mol)):
        raise ValueError('Specify ligand stereochemistry before proposing analogs')
    return mol


def canonical(mol):
    return Chem.MolToSmiles(mol, canonical=True, isomericSmiles=True)


class LigandEdit(BaseModel):
    name: str = Field(min_length=1)
    smarts: str = Field(min_length=1)


class LigandAnalogConfig(BaseConfig):
    edits: list[LigandEdit] = ConfigField(min_length=1, title='Graph edits',
        description='Named, single-reactant/single-product RDKit reaction SMARTS')
    fixed_core_smarts: str = ConfigField(title='Fixed chemical core',
        description='Required scaffold query, including existing stereocenters and their neighbors')
    max_heavy_atoms: int = ConfigField(default=56, ge=1, le=128, title='Size limit',
        description='Campaign proposal bound; not a universal drug-likeness rule')
    preserve_formal_charge: bool = ConfigField(default=True, title='Preserve charge',
        description='Reject charge-changing edits; preparation states must remain explicit')
    max_products_per_edit: int = ConfigField(default=64, ge=1, le=512, title='Enumeration limit',
        description='Fail if an edit exceeds this product count rather than silently truncating')
    output_dir: str = ConfigField(default='output/ligand-proposals', title='Evidence directory',
        description='Requests, accepted/rejected enumeration and selected proposals')


@generator(key='ligand-analogs', label='RDKit ligand analog proposals', config=LigandAnalogConfig,
    description='Apply authored graph edits around an explicit fixed ligand core; preserves specified chemistry and captures rejected products. Not an affinity model or synthesis planner.',
    uses_gpu=False, tools_called=[], supported_sequence_types=['ligand'])
class LigandAnalogGenerator(Generator):
    input_type = GeneratorInputType.STARTING_SEQUENCE
    allows_ligand_proposals = True

    def __init__(self, config: LigandAnalogConfig):
        super().__init__()
        if not hasattr(Generator, 'allows_ligand_proposals'):
            raise RuntimeError('Infrastructure must apply proto-ligand-proposals.patch before use')
        self.config = config
        self.core = Chem.MolFromSmarts(config.fixed_core_smarts)
        if self.core is None or not self.core.GetNumAtoms():
            raise ValueError('Invalid fixed_core_smarts')
        names = [e.name for e in config.edits]
        if len(names) != len(set(names)):
            raise ValueError('Graph edit names must be unique')
        self.reactions = []
        for edit in config.edits:
            rxn = rdChemReactions.ReactionFromSmarts(edit.smarts)
            if rxn is None or rxn.GetNumReactantTemplates() != 1 or rxn.GetNumProductTemplates() != 1:
                raise ValueError('Each graph edit needs one reactant and one product')
            _, errors = rxn.Validate(silent=True)
            if errors:
                raise ValueError(f'Invalid graph edit: {edit.name}')
            self.reactions.append((edit.name, rxn))

    def _enumerate(self, smiles):
        parent = molecule(smiles)
        parent_smiles = canonical(parent)
        matches = parent.GetSubstructMatches(self.core, useChirality=True)
        if not matches:
            raise ValueError('Parent does not match the fixed chemical core')
        stereo_atoms = {s.centeredOn for s in Chem.FindPotentialStereo(parent)
                        if s.type == Chem.StereoType.Atom_Tetrahedral}
        # A chiral query must constrain the center and its explicit neighbors.
        required = stereo_atoms | {n.GetIdx() for i in stereo_atoms for n in parent.GetAtomWithIdx(i).GetNeighbors()}
        if stereo_atoms and (not required <= set(matches[0]) or
                sum(a.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED for a in self.core.GetAtoms()) < len(stereo_atoms)):
            raise ValueError('Fixed core must explicitly preserve parent stereocenters and neighbors')
        stereo_bonds = [parent.GetBondWithIdx(s.centeredOn) for s in Chem.FindPotentialStereo(parent)
                        if s.type == Chem.StereoType.Bond_Double]
        for bond in stereo_bonds:
            ends = {bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()}
            required = ends | {n.GetIdx() for i in ends for n in parent.GetAtomWithIdx(i).GetNeighbors()}
            if not required <= set(matches[0]):
                raise ValueError('Fixed core must preserve specified double-bond stereochemistry')
        if len(stereo_bonds) > sum(b.GetStereo() != Chem.BondStereo.STEREONONE for b in self.core.GetBonds()):
            raise ValueError('Fixed core must preserve specified double-bond stereochemistry')
        records, unique = [], {}
        for name, rxn in self.reactions:
            products = rxn.RunReactants((parent,), maxProducts=self.config.max_products_per_edit + 1)
            if len(products) > self.config.max_products_per_edit:
                raise ValueError(f'Enumeration limit exceeded: {name}')
            for (product,) in products:
                record = {'edit': name, 'unsanitized_smiles': Chem.MolToSmiles(product)}
                try:
                    Chem.SanitizeMol(product)
                    for atom in product.GetAtoms():
                        atom.SetAtomMapNum(0)
                    Chem.AssignStereochemistry(product, cleanIt=True, force=True)
                    raw = canonical(product)
                    record['smiles'] = raw
                    clean = molecule(raw)
                    if not clean.HasSubstructMatch(self.core, useChirality=True):
                        raise ValueError('Fixed core or stereochemistry changed')
                    if clean.GetNumHeavyAtoms() > self.config.max_heavy_atoms:
                        raise ValueError('Heavy atom limit exceeded')
                    if self.config.preserve_formal_charge and Chem.GetFormalCharge(clean) != Chem.GetFormalCharge(parent):
                        raise ValueError('Formal charge changed')
                    if raw == parent_smiles:
                        raise ValueError('Unchanged parent')
                    record['accepted'] = True
                    unique.setdefault(raw, []).append(name)
                except (ValueError, RuntimeError) as error:
                    record.update(accepted=False, reason=str(error))
                records.append(record)
        return parent_smiles, unique, records

    def _sample(self):
        self._validate_generator()
        directory = Path(self.config.output_dir).resolve() / uuid.uuid4().hex
        directory.mkdir(parents=True, exist_ok=False)
        seed = self._next_seed()
        rng = random.Random(seed)
        parents = [p.sequence for p in self.segment.proposal_sequences]
        write(directory/'request.json', {'parents': parents, 'seed': seed,
            'config': self.config.model_dump(mode='json'), 'rdkit_version': Chem.rdBase.rdkitVersion})
        enumerations, selected, pools = {}, [], {}
        try:
            for smiles in parents:
                key = canonical(molecule(smiles))
                if key not in enumerations:
                    _, options, records = self._enumerate(smiles)
                    enumerations[key] = {'products': records, 'unique_admissible': options}
                    write(directory/'enumeration.json', enumerations)
                options = enumerations[key]['unique_admissible']
                if not options:
                    raise ValueError('No admissible changed ligand from the configured edits')
                if not pools.get(key):
                    pools[key] = sorted(options)
                    rng.shuffle(pools[key])
                child = pools[key].pop()
                selected.append(Sequence(sequence=child, sequence_type='ligand', metadata={
                    'parent_smiles': key, 'graph_edits': options[child],
                    'proposal_capture': str(directory),
                }))
            self.segment.proposal_sequences = selected
            write(directory/'selected.json', [s.metadata for s in selected])
            write(directory/'receipt.json', {'success': True, 'requested': len(parents), 'returned': len(selected)})
        except Exception as error:
            write(directory/'receipt.json', {'success': False, 'error': str(error),
                'selected_before_failure': len(selected)})
            raise
