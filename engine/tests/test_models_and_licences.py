"""Model manager offline behaviour (token storage, mirror URLs, error codes) + the licence inventory."""
import urllib.error

import pytest

from viku import config, licences, models
from viku.jobs import JobError


def test_hf_token_is_stored_encrypted_and_never_returned(data_dir):
    config.save_settings({"hf_token": "hf_TESTsecret123"})
    raw = (data_dir / "settings.json").read_text(encoding="utf-8")
    assert "hf_TESTsecret123" not in raw
    assert config.hf_token() == "hf_TESTsecret123"
    pub = config.public_settings()
    assert pub["hf_token_set"] is True and "hf_token" not in pub and "hf_token_dpapi" not in pub
    config.save_settings({"hf_token": ""})            # round-tripping GET -> POST keeps it
    assert config.hf_token() == "hf_TESTsecret123"
    config.save_settings({"hf_token": None})          # null clears it
    assert config.hf_token() == ""


def test_gated_item_reports_token_need_and_mirror_rewrites_hf_urls():
    it = {x["id"]: x for x in models.list_items()}["indic-conformer"]
    assert it["gated"] and it["needs_token"]
    assert it["accept_url"] == "https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual"
    items = models._items("https://mirror.example.org/hf/")
    urls = [f["url"] for f in items["indic-conformer"]["files"]]
    assert all(u.startswith("https://mirror.example.org/hf/ai4bharat/indic-conformer-600m-multilingual/resolve/")
               for u in urls)
    assert items["ffmpeg"]["archive"]["url"].startswith("https://github.com/")   # non-HF items untouched


@pytest.mark.parametrize("code,expected", [(401, "hf_auth_required"), (403, "hf_auth_required")])
def test_hf_auth_error_code(monkeypatch, tmp_path, code, expected):
    def boom(req, timeout=60):
        raise urllib.error.HTTPError(req.full_url, code, "Unauthorized", {}, None)
    monkeypatch.setattr(models._opener, "open", boom)
    from viku.jobs import Job, MANAGER
    j = Job(MANAGER, "t")
    url = "https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual/resolve/abc/assets/x.onnx"
    with pytest.raises(JobError) as e:
        models._download(url, tmp_path / "x.part", 10, "0" * 64, models._Progress(j, 10), j,
                         "https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual")
    assert e.value.code == expected
    assert e.value.info["accept_url"].endswith("indic-conformer-600m-multilingual")


def test_licences_cover_every_component_kind():
    cs = licences.components()
    kinds = {c["kind"] for c in cs}
    assert {"python", "runtime", "tool", "model", "font", "data"} <= kinds
    by = {c["id"]: c for c in cs}
    assert by["indic-conformer"]["licence"] == "MIT"
    assert "OFL" in by["fonts"]["licence"] or "Open Font" in by["fonts"]["licence"]
    assert by["bible:ory"]["attribution"].endswith("Bridge Connectivity Solutions, CC BY-SA 4.0")
    assert by["bible:eng-web"]["licence"] == "Public domain"
    names = {c["name"] for c in cs if c["kind"] == "python"}
    assert {"fastapi", "numpy", "onnxruntime", "faster-whisper", "ctranslate2"} <= names
    assert "pytest" not in names                      # dev-only packages are not shipped
    assert all(c["licence"] for c in cs)
    md = licences.notices_markdown()
    assert "## Bible texts" in md and "| torch |" in md
