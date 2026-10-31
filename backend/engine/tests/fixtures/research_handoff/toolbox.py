"""CPU-only fixture predictors. No biological measurements or learned models.

Two available predictor heads return different normalized responses for a fixed DNA
library. Neither head's name encodes its applicability to a particular context.
Calibration must come from the supplied source. Selection is native Proto's job.
"""
LIBRARY = ['ATGCATGC', 'TACGTACG', 'GATCGATC', 'CGTACGTA', 'AACCGGTT', 'TTGGCCAA']
RESPONSES = {
    'u': dict(zip(LIBRARY, [0.95, 0.82, 0.18, 0.24, 0.48, 0.35])),
    'v': dict(zip(LIBRARY, [0.12, 0.25, 0.91, 0.78, 0.40, 0.50])),
}


def predict_response(sequence, head):
    """Return a synthetic response in [0,1]; larger means greater response.

    Only fixed-library sequences and heads u/v are supported. Missing applicability
    is not a zero prediction and unsupported sequences must not be invented.
    """
    return RESPONSES[head][sequence]
