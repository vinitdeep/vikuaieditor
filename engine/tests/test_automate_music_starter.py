"""Automate reports the stored reel title; starter illustration pack import; generated music beds."""
import contextlib
import json
import time
from pathlib import Path

import numpy as np
import pytest

from viku import automate, config, library, music, music_gen, projects
from viku.jobs import JobManager


class _Job:
    """Minimal stand-in for jobs.Job (no thread pool)."""

    def update(self, p=None, m=None):
        pass

    def span(self, a, b):
        pass

    def scope(self, a, b):
        return contextlib.nullcontext()

    def check(self):
        pass


def test_automate_result_title_is_the_stored_reel_title(monkeypatch, tmp_path):
    video = tmp_path / "sermon.mp4"
    video.write_bytes(b"x")
    from viku.media import ff
    monkeypatch.setattr(ff, "probe", lambda path: {"duration": 600.0, "fps": 30.0, "width": 1920, "height": 1080})
    monkeypatch.setattr(automate.analyze, "run", lambda pid, job, rng=None: None)
    monkeypatch.setattr(automate, "suggest_job", lambda pid, job, count=3, rng=None: [
        {"id": "s1", "score": 0.84, "title": "ताकि वो परमेश्वर में आए!", "segments": [[10.0, 40.0]]}])

    def fake_autobuild(rid, job, steps=None):   # the hook writer + title gate pick another line
        def upd(p):
            for r in p["reels"]:
                if r["id"] == rid:
                    r.update({"title": "बेटी जो बोलते हैं", "sub": "John 15:5", "title_flag": None, "mood": "hopeful"})
        projects.update(rid.split("~")[0], upd)
        return projects.find_reel(rid)[1]
    monkeypatch.setattr(automate.reel, "autobuild", fake_autobuild)
    monkeypatch.setattr(automate.reel, "render", lambda rid, job: {"path": "x.mp4", "thumbnail": "x.jpg"})

    res = automate.run(_Job(), video_path=str(video), language="hi", count=1)
    (r0,) = res["reels"]
    stored = projects.find_reel(r0["reel"])[1]
    assert r0["title"] == stored["title"] == "बेटी जो बोलते हैं"
    assert r0["suggested_title"] == "ताकि वो परमेश्वर में आए!"
    assert r0["sub"] == "John 15:5" and r0["mood"] == "hopeful" and r0["path"] == "x.mp4"


# ----------------------------------------------------------------- starter --
def test_starter_pack_index_is_complete_and_small():
    d = config.starter_dir()
    if d is None:
        pytest.skip("no data/starter in this checkout")
    idx = json.loads((d / "illustrations" / "index.json").read_text(encoding="utf-8"))
    assert idx["count"] == len(idx["items"]) >= 100
    assert idx["bytes"] <= 60e6
    assert "free to use in Viku videos" in idx["licence"]
    for it in idx["items"]:
        assert {"id", "file", "title", "tags", "desc", "set"} <= set(it)
        assert (d / "illustrations" / it["file"]).exists()
        assert it["width"] == 1080 and it["height"] == 1920
    ids = [it["id"] for it in idx["items"]]
    assert len(set(ids)) == len(ids)


def test_starter_import_into_empty_library(monkeypatch, tmp_path):
    from PIL import Image
    root = tmp_path / "starter" / "illustrations" / "1-made-beautiful"
    root.mkdir(parents=True)
    Image.new("RGB", (108, 192), (200, 160, 90)).save(root / "01-pristine-earth.jpg", quality=85)
    rel = Path("1-made-beautiful/01-pristine-earth.jpg")
    idx = {"version": 1, "licence": "x", "count": 1, "bytes": 1, "items": [
        {"id": "abc123starter001", "file": rel.as_posix(), "title": "01-pristine-earth", "tags": library.tags_for(rel),
         "desc": library.describe(str(rel), "01-pristine-earth"), "set": "1-made-beautiful", "width": 108,
         "height": 192}]}
    (tmp_path / "starter" / "illustrations" / "index.json").write_text(json.dumps(idx), encoding="utf-8")
    monkeypatch.setenv("VIKU_STARTER", str(tmp_path / "starter"))
    monkeypatch.delenv("VIKU_DEV", raising=False)
    before = library.count()
    r = library.seed()                       # /library/import {seed: true} = the starter pack (no user folders)
    assert r["added"] == 1 and library.count() == before + 1
    assert library.import_starter()["added"] == 0      # idempotent
    it = next(i for i in library.items() if i["id"] == "abc123starter001")
    assert it["desc"] == "pristine earth" and {"pristine", "earth", "beautiful", "starter"} <= set(it["tags"])
    st = library.starter_status()
    assert st["available"] and st["imported"] == st["count"] == 1


def test_user_folder_seeds_are_dev_only(monkeypatch):
    monkeypatch.delenv("VIKU_DEV", raising=False)
    assert not config.dev_mode()
    assert music.seed() == []


# ------------------------------------------------------------------- music --
@pytest.fixture(scope="module")
def beds():
    return {m: music_gen.generate(m, 1, 24.0) for m in music_gen.MOODS}


def test_five_moods_and_theme_mapping():
    assert set(music_gen.MOODS) >= {"hopeful", "victorious", "reflective", "prayerful", "uplifting"}
    assert music_gen.mood_for_theme("victory") == "victorious"
    assert music_gen.mood_for_theme("prayer") == "prayerful"
    assert music_gen.mood_for_theme("depression") == "reflective"
    assert music_gen.mood_for_theme(None) == "hopeful"


def test_beds_are_stereo_48k_at_bed_level_and_never_clip(beds):
    for mood, (x, info) in beds.items():
        assert x.dtype == np.float32 and x.ndim == 2 and x.shape[1] == 2
        assert abs(x.shape[0] / music_gen.SR - 24.0) < 0.5
        assert -15.0 <= info["lufs"] <= -13.5, mood
        assert info["true_peak"] <= -1.4 and np.abs(x).max() < 0.9, mood
        assert abs(music_gen.lufs(x) - info["lufs"]) < 0.05


def test_beds_are_deterministic_and_seeded(beds):
    x2, _ = music_gen.generate("prayerful", 1, 24.0)
    assert np.array_equal(x2, beds["prayerful"][0])
    x3, _ = music_gen.generate("prayerful", 2, 24.0)
    n = min(len(x2), len(x3))
    assert not np.array_equal(x3[:n], x2[:n])


def test_beds_loop_without_a_click(beds):
    for mood, (x, _) in beds.items():
        assert music_gen.loop_seam(x) < 1.0, mood


def test_no_bell_like_energy(beds):
    for mood, (x, _) in beds.items():
        bc = music_gen.bell_check(x)
        assert bc["hf_db"] < -35 and bc["tonal_onsets"] == 0, (mood, bc)


def test_bell_detector_catches_a_bell(beds):
    x = beds["hopeful"][0].copy()
    sr = music_gen.SR
    t = np.arange(int(1.5 * sr)) / sr
    bell = sum(a * np.sin(2 * np.pi * 1200 * r * t) for r, a in zip([1, 2.0, 2.4, 3.0, 4.1], [1, .6, .5, .4, .3]))
    bell = (bell * np.exp(-t / 0.8) * (1 - np.exp(-t / 0.002))).astype(np.float32) * 0.1
    for s in range(0, len(x) - len(t), 2 * sr):
        x[s:s + len(t)] += bell[:, None]
    assert music_gen.bell_check(x)["tonal_onsets"] >= 8


def test_generate_job_adds_tagged_track_and_pick_by_mood():
    mgr = JobManager()
    job = mgr.submit("t", lambda j: music.generate(j, "victorious", 3, 20.0))
    for _ in range(1200):
        if job.state in ("done", "error"):
            break
        time.sleep(0.05)
    assert job.state == "done", job.error
    res = job.result
    assert Path(res["path"]).exists() and res["path"].endswith(".flac")
    tr = next(t for t in music.list_tracks() if t["name"] == res["name"])
    assert music.GEN_TAG in tr["tags"] and tr["mood"] == "victorious" and tr["source"] == "viku"
    assert music.pick("victorious", "p~1")["name"] == res["name"]
    assert music.remove(res["name"]) and not Path(res["path"]).exists()
