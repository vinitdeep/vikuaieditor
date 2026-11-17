"""Offline test setup: every test runs against a fresh, empty data dir (no models, no network, no %APPDATA%)."""
import atexit
import os
import shutil
import tempfile
from pathlib import Path

import pytest

_TMP = tempfile.mkdtemp(prefix="viku-tests-")
atexit.register(shutil.rmtree, _TMP, True)
os.environ["VIKU_DATA"] = _TMP          # before any viku import: config.data_dir() reads it
os.environ.pop("HF_TOKEN", None)
os.environ.pop("HUGGING_FACE_HUB_TOKEN", None)


@pytest.fixture()
def data_dir() -> Path:
    return Path(_TMP)
