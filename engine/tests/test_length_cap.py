"""Automate / suggest reel length: 10 s - 5 min; the slider is the length the reel should have (90-100 %)."""
from viku.brain import clipfinder, planner, ranker


def _items(n: int, step: float = 3.0, dur: float = 2.6) -> list[dict]:
    # cues every `step` s, each `dur` s long -> 0.4 s pauses between them
    return [{"start": i * step, "end": i * step + dur, "text": f"line {i} words here"} for i in range(n)]


def test_length_bounds_clamped_and_target_is_the_slider():
    assert clipfinder.length_bounds(60) == (36.0, 78.0, 60.0)
    assert clipfinder.length_bounds(10) == (6.0, 13.0, 10.0)
    assert clipfinder.length_bounds(300) == (180.0, 390.0, 300.0)
    assert clipfinder.length_bounds(3)[2] == 10.0      # below the floor
    assert clipfinder.length_bounds(9999)[2] == 300.0  # above the ceiling
    assert clipfinder.reel_floor(60) == 54.0 and clipfinder.reel_floor(10) == 8.0 and clipfinder.reel_floor(300) == 270.0


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


def _pauses(items):
    return [[items[k]["end"], items[k + 1]["start"]] for k in range(len(items) - 1)]


def _secs(segs):
    return sum(b - a for a, b in segs)


def test_fit_length_reaches_the_target_after_jump_cuts():
    # every 4th line is an "amen" response the planner cuts out -> a 45 s source window is only ~33 s of reel
    items = _items(200)
    for k in range(2, len(items), 4):
        items[k]["text"] = "amen"
    pauses = _pauses(items)
    for target in (10.0, 30.0, 60.0, 120.0, 300.0):
        i, j, segs, secs = clipfinder.fit_length(items, 10, 20, pauses, "en", target)
        assert abs(secs - _secs(segs)) < 1e-6
        assert clipfinder.reel_floor(target) <= secs <= target + clipfinder.OVER, (target, secs)
        assert i == 10 or target >= 120   # the start only moves when the end alone cannot reach the target


def test_fit_length_shrinks_a_window_that_is_too_long():
    items = _items(200)
    i, j, segs, secs = clipfinder.fit_length(items, 0, 60, _pauses(items), "en", 30.0)
    assert i == 0 and j < 60 and 27.0 <= secs <= 30.0 + clipfinder.OVER


def test_fit_length_short_analysed_part_gives_the_longest_possible():
    items = _items(12)   # ~35 s of speech in total
    i, j, segs, secs = clipfinder.fit_length(items, 3, 6, _pauses(items), "en", 60.0)
    assert (i, j) == (0, 11) and secs < clipfinder.reel_floor(60.0)


def test_fit_length_never_crosses_an_unanalysed_hole():
    a = _items(10)                                     # 0 .. 29.6 s
    b = [dict(t, start=t["start"] + 100, end=t["end"] + 100) for t in _items(30)]  # 100 s on
    items = a + b
    i, j, segs, secs = clipfinder.fit_length(items, 0, 3, _pauses(items), "en", 60.0)
    assert j <= 9 and all(e <= 30 for _, e in segs)


def test_fit_length_uses_short_pauses_when_long_ones_miss_the_length():
    # fast speech: cue gaps 0.1 s (= 0.4 s of real silence once the 0.15 s padding is removed), a long 0.6 s pause
    # only every 10 cues (~30 s). Before: the reel stopped at the last long pause -> ~30 s for a 60 s target.
    items, t = [], 0.0
    for k in range(120):
        items.append({"start": t, "end": t + 2.9, "text": f"line {k} words here"})
        t += 2.9 + (0.6 if k % 10 == 9 else 0.1)
    i, j, segs, secs = clipfinder.fit_length(items, 0, 9, _pauses(items), "en", 60.0)
    assert 54.0 <= secs <= 60.0 + clipfinder.OVER, secs


def test_long_targets_rank_fewer_starts():
    items = _items(400)
    n60 = len(clipfinder.build_windows(items, *clipfinder.length_bounds(60)[:2]))
    n300 = len(clipfinder.build_windows(items, *clipfinder.length_bounds(300)[:2]))
    assert n300 < n60
