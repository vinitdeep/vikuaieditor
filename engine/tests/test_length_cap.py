"""Automate / suggest length cap: 10 s - 5 min, 60 s behaves exactly as before."""
from viku.brain import clipfinder, planner, ranker


def _items(n: int, step: float = 3.0, dur: float = 2.6) -> list[dict]:
    # cues every `step` s, each `dur` s long -> 0.4 s pauses between them
    return [{"start": i * step, "end": i * step + dur, "text": f"line {i} words here"} for i in range(n)]


def test_length_bounds_clamped_and_60_unchanged():
    assert clipfinder.length_bounds(60) == (20.0, 60.0, 45.0)
    assert clipfinder.length_bounds(10) == (5.0, 10.0, 7.5)
    assert clipfinder.length_bounds(300) == (20.0, 300.0, 225.0)
    assert clipfinder.length_bounds(3)[1] == 10.0      # below the floor
    assert clipfinder.length_bounds(9999)[1] == 300.0  # above the ceiling


def test_windows_respect_the_cap():
    items = _items(200)
    for cap in (10, 30, 60, 120, 300):
        lo, hi, _ = clipfinder.length_bounds(cap)
        wins = clipfinder.build_windows(items, lo, hi)
        assert wins, cap
        for i, j in wins:
            d = items[j]["end"] - items[i]["start"]
            assert lo <= d <= hi, (cap, d)


def test_long_caps_keep_window_count_bounded():
    items = _items(200)
    lo, hi, _ = clipfinder.length_bounds(300)
    wins = clipfinder.build_windows(items, lo, hi)
    starts = {i for i, _ in wins}
    assert max(sum(1 for i, _ in wins if i == s) for s in starts) <= clipfinder.MAX_ENDS
    # the longest allowed end is still offered from an early start
    assert max(items[j]["end"] - items[i]["start"] for i, j in wins) > 290


def test_planner_caps_at_max_len():
    items = _items(120)
    pauses = [[it["end"], it["end"] + 0.4] for it in items]
    for cap in (10.0, 45.0, 60.0, 300.0):
        segs = planner.plan(items, pauses, "en", cap)
        assert sum(b - a for a, b in segs) <= cap + 1e-6, cap
    # default stays 60 s
    assert sum(b - a for a, b in planner.plan(items, pauses, "en")) <= 60.0 + 1e-6


def test_duration_fit_scales_with_target():
    w45 = _items(15)  # 0 .. 44.6 s
    assert abs(ranker.raw_features(w45, "en")["duration_fit"] - (1 - abs(44.6 - 45) / 25)) < 1e-9
    short = _items(3)  # 8.6 s
    assert ranker.raw_features(short, "en", target=7.5)["duration_fit"] > 0.7
    assert ranker.raw_features(short, "en")["duration_fit"] == 0.0
