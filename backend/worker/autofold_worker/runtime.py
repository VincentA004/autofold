"""Non-scientific batch-process initialization, before Proto imports."""

import os


def configure_headless() -> None:
    os.environ["PROTO_NO_SPINNER"] = "1"
    os.environ["TQDM_DISABLE"] = "1"
    # Disabled tqdm instances still start the class-wide monitor in __new__.
    # Set this before the first progress instance, not after a lock is stranded.
    try:
        from tqdm import tqdm
    except ModuleNotFoundError as error:
        if error.name != "tqdm":
            raise
    else:
        tqdm.monitor_interval = 0
