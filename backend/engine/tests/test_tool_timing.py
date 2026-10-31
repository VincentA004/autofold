"""A backwards system clock must not invalidate a completed native tool response."""
import unittest
from unittest.mock import patch

from proto_tools.tools.tool_registry import tool
from proto_tools.utils import BaseConfig
from proto_tools.utils.tool_io import BaseToolInput, BaseToolOutput


class ClockInput(BaseToolInput):
    pass


class ClockOutput(BaseToolOutput):
    value: float

    @property
    def output_format_options(self): return ['json']

    @property
    def output_format_default(self): return 'json'

    def _export_output(self, export_path, file_format):
        raise NotImplementedError('Fixture does not export')


class NativeToolTimingTests(unittest.TestCase):
    def test_completed_response_survives_backward_wall_clock_adjustment(self):
        wall_clock = [1000.0]

        @tool(key='autofold-timing-regression', label='Clock fixture', category='test',
              description='CPU timing regression fixture', input_class=ClockInput,
              config_class=BaseConfig, output_class=ClockOutput,
              uses_gpu=False, cacheable=False)
        def run(inputs, config, instance=None):
            wall_clock[0] -= 5.0
            return ClockOutput(value=42.0)

        with patch('proto_tools.tools.tool_registry.time.time', side_effect=lambda: wall_clock[0]):
            result = run(ClockInput(), BaseConfig(device='cpu'))
            # Revalidation is also exercised by pool output merging.
            validated = ClockOutput.model_validate(result.model_dump())
        self.assertEqual(validated.value, 42.0)
        self.assertTrue(validated.success)
        self.assertGreaterEqual(validated.execution_time, 0.0)


if __name__ == '__main__': unittest.main()
