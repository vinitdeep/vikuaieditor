"""Automate pick mode: analyse + suggest only, then build the suggestion the editor chose."""
import pytest

from viku import automate
from viku.jobs import JobError


class FakeJob:
    def __init__(self):
        self.updates = []

    @staticmethod
    def scope(a, b):
        import contextlib
        return contextlib.nullcontext()

    def update(self, *a):
        self.updates.append(a)


def test_pick_stops_after_suggest(monkeypatch):
    calls = []
    monkeypatch.setattr(automate.projects, "load", lambda pid: {"id": pid})
    monkeypatch.setattr(automate.analyze, "run", lambda pid, job, rng: calls.append(("analyze", pid, rng)))
    sug = [{"id": f"s{i}", "segments": [[i * 100.0, i * 100.0 + 58]], "title": f"T{i}", "score": 0.9 - i / 10,
            "duration": 58.0} for i in range(1, 6)]
    monkeypatch.setattr(automate, "suggest_job", lambda pid, job, count, rng, max_seconds, max_overlap: calls.append(
        ("suggest", count, max_seconds, max_overlap)) or sug[:count])
    monkeypatch.setattr(automate, "build_reel", lambda *a, **k: pytest.fail("pick mode must not build"))
    out = automate.run(FakeJob(), project_id="p1", count=1, rng=[10, 400], max_seconds=60, pick=5)
    assert out == {"project": "p1", "stage": "pick", "suggestions": sug}
    assert calls == [("analyze", "p1", [10, 400]), ("suggest", 5, 60, 0.5)]


def test_find_suggestion_prefers_the_one_the_app_sends(monkeypatch):
    monkeypatch.setattr(automate.projects, "load", lambda pid: {"id": pid, "suggestions": [
        {"id": "s1", "segments": [[1.0, 2.0]], "title": "stored", "score": 0.5}]})
    s = automate.find_suggestion("p1", "s1", {"id": "s1", "segments": [[10, 70.5]], "title": "shown", "score": 0.8})
    assert s == {"id": "s1", "segments": [[10.0, 70.5]], "title": "shown", "score": 0.8}
    assert automate.find_suggestion("p1", "s1")["title"] == "stored"
    with pytest.raises(JobError):
        automate.find_suggestion("p1", "s9")
    with pytest.raises(JobError):
        automate.find_suggestion("p1", "x", {"segments": [[5, 3]]})


def test_build_suggestion_has_the_automate_result_shape(monkeypatch):
    monkeypatch.setattr(automate, "build_reel", lambda pid, s, job, render, framing="follow": {
        "reel": f"{pid}~7", "title": s["title"], "render": render, "framing": framing})
    out = automate.build_suggestion(FakeJob(), "p1", {"id": "s2", "segments": [[0, 50]], "title": "T", "score": 1})
    assert out == {"project": "p1", "reels": [{"reel": "p1~7", "title": "T", "render": True, "framing": "follow"}]}
    out = automate.build_suggestion(FakeJob(), "p1", {"id": "s2", "segments": [[0, 50]], "title": "T", "score": 1},
                                    framing="fixed")
    assert out["reels"][0]["framing"] == "fixed"


def test_build_suggestions_makes_every_marked_clip_in_order(monkeypatch):
    made = []
    monkeypatch.setattr(automate, "build_reel", lambda pid, s, job, render, framing="follow": made.append(s["id"]) or {
        "reel": f"{pid}~{len(made)}", "suggestion": s["id"], "framing": framing})
    picked = [{"id": f"s{i}", "segments": [[i * 100.0, i * 100.0 + 50]], "title": f"T{i}", "score": 1} for i in (3, 1, 4)]
    out = automate.build_suggestions(FakeJob(), "p1", picked, framing="fixed")
    assert made == ["s3", "s1", "s4"]
    assert [r["suggestion"] for r in out["reels"]] == ["s3", "s1", "s4"]
    assert out["project"] == "p1" and all(r["framing"] == "fixed" for r in out["reels"])
