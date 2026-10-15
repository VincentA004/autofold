import hashlib
import json
import unittest
from autofold_worker.protocol import ProtocolError, pipeline_policy_hash


class PipelineWireTests(unittest.TestCase):
    def test_portable_host_bytes_hash_without_python_number_or_unicode_rendering(self):
        value = {'a': 0.00001, 'b': 'β protein 🧬', 'keys': {'2': 2, '10': 10}}
        wire = '{"a":0.00001,"b":"β protein 🧬","keys":{"2":2,"10":10}}'
        self.assertEqual(pipeline_policy_hash(value, wire), 'sha256:' + hashlib.sha256(wire.encode()).hexdigest())
        self.assertNotEqual(pipeline_policy_hash(value), pipeline_policy_hash(value, wire))

    def test_legacy_verification_bytes_remain_unchanged(self):
        value = {'z': 0.001, 'a': [1, True, None]}
        legacy = json.dumps(value, sort_keys=True, separators=(',', ':'))
        self.assertEqual(pipeline_policy_hash(value), 'sha256:' + hashlib.sha256(legacy.encode()).hexdigest())

    def test_every_nested_value_and_json_type_must_match(self):
        for value, wire in [({'a': True}, '{"a":1}'), ({'a': [0.1]}, '{"a":[0.2]}'),
                            ({'a': None}, '{"a":"null"}'), ({'a': 1}, '{"a":1,"b":2}')]:
            with self.subTest(value=value), self.assertRaisesRegex(ProtocolError, 'do not match'):
                pipeline_policy_hash(value, wire)

    def test_duplicate_keys_nonfinite_numbers_and_invalid_json_are_rejected(self):
        for wire in ['{"a":1,"a":1}', '{"a":NaN}', '{"a":Infinity}', '{"a":1e999}', '{']:
            with self.subTest(wire=wire), self.assertRaises(ProtocolError):
                pipeline_policy_hash({'a': float('inf')}, wire)

    def test_wire_bytes_are_bounded_in_utf8(self):
        with self.assertRaisesRegex(ProtocolError, '1 MiB'):
            pipeline_policy_hash({}, '🧬' * (1024 * 1024 // 4 + 1))
        with self.assertRaises(ProtocolError):
            pipeline_policy_hash({}, 7)


class NativeInvocationReservationTests(unittest.TestCase):
    def fixture(self):
        from pathlib import Path
        value=json.loads((Path(__file__).parent/'fixtures/native-search-portable-bundle.json').read_text())
        budget=value['pipeline']['executionBudget']
        count=value['pipeline']['nativeSearch']['budget']['maximumCandidates']
        reservations=[]
        for stage in value['pipeline']['stages']:
            requests=count*len(value['seeds'])*len(stage['models'])
            seconds=stage.get('budget',{}).get('maximumGpuSeconds',0)
            reservations.append({'stageId':stage['id'],'maximumCandidates':count,'seedCount':len(value['seeds']),
                'modelCount':len(stage['models']),'maximumRequests':requests,'perRequestTimeoutSeconds':seconds,'reservedWallSeconds':requests*seconds})
        budget.update(unit='wall_seconds',reservationSemantics='per_model_candidate_seed_timeout_upper_bound_v1',
            invocationReservations=reservations,reservedEvidenceWallSeconds=sum(item['reservedWallSeconds'] for item in reservations))
        return value

    def validate(self,value):
        from autofold_worker.protocol import validate_bundle
        value['pipelineHash']=pipeline_policy_hash(value['pipeline'])
        return validate_bundle(value)

    def test_fresh_units_and_cardinality_recompute_before_execution(self):
        value=self.fixture()
        self.validate(value)
        value['seeds'].append(7)
        with self.assertRaisesRegex(ProtocolError,'cardinality'):
            self.validate(value)

    def test_boolean_counts_and_ambiguous_units_cannot_masquerade_as_integer_reservations(self):
        value=self.fixture()
        value['pipeline']['executionBudget']['invocationReservations'][0]['seedCount']=True
        with self.assertRaisesRegex(ProtocolError,'cardinality'):
            self.validate(value)
        value=self.fixture()
        value['pipeline']['executionBudget']['unit']='actual_gpu_compute_seconds'
        with self.assertRaisesRegex(ProtocolError,'units'):
            self.validate(value)

    def test_fresh_model_stage_cannot_omit_or_falsify_its_deadline_even_for_cpu(self):
        for deadline in (None, 0, True, float("inf")):
            with self.subTest(deadline=deadline):
                value = self.fixture()
                if deadline is None:
                    value["pipeline"]["stages"][0].pop("budget", None)
                else:
                    value["pipeline"]["stages"][0]["budget"]["maximumGpuSeconds"] = deadline
                with self.assertRaises(ProtocolError):
                    self.validate(value)

    def test_original_profile_without_new_reservation_metadata_remains_readable(self):
        value=self.fixture()
        budget=value['pipeline']['executionBudget']
        for key in ('unit','reservationSemantics','invocationReservations','reservedEvidenceWallSeconds'):
            budget.pop(key)
        # Add an old diagnostic without a per-request deadline; do not change
        # the original locked scoring stage or its protected scoring hash.
        diagnostic = dict(value["pipeline"]["stages"][0])
        diagnostic.update(id="legacy_diagnostic_without_deadline", role="diagnostic")
        diagnostic.pop("budget", None)
        value["pipeline"]["stages"].append(diagnostic)
        self.validate(value)

if __name__ == '__main__':
    unittest.main()
