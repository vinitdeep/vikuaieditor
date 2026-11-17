"""Auto framing (media/framing.py): the follow path keeps the speaker centred, ignores sway, resets at cuts,
and is looked up by source time so editor trims / moves keep it."""
import numpy as np
import pytest

from viku.media import framing as fr

RATE, SAMPLE, W, CW = fr.FOLLOW_RATE, fr.SAMPLE, fr.W, fr.CW


def samples(fn, secs):
    """face x at SAMPLE/s from a function of reel seconds"""
    return np.array([fn(i / SAMPLE) for i in range(int(secs * SAMPLE))], float)


def test_sway_inside_the_dead_zone_holds_the_frame_still():
    x = 600 + 12 * np.sin(np.arange(100) / 3)
    p = fr.follow_path(x)
    assert np.ptp(p) == 0
    assert abs(p[0] - 600) < fr.DEAD


def test_a_walk_is_followed_and_ends_centred():
    # stands at 400 for 3 s, walks to 850 in 3 s, stands 4 s
    t = np.arange(100) / RATE
    x = np.interp(t, [0, 3, 6, 10], [400, 400, 850, 850])
    p = fr.follow_path(x)
    assert abs(p[0] - 400) <= fr.DEAD + 1
    assert abs(p[-1] - 850) <= fr.DEAD + 1
    assert np.max(np.abs(p - x)) < 60            # never loses him (405-px crop: +-202 px)
    assert np.max(np.abs(np.diff(p))) < 25        # eased: no jumps between 0.1 s samples
    assert abs(p[45] - x[45]) < 40                # mid-walk the camera is with him, not seconds behind


def test_path_stays_inside_the_source_frame():
    p = fr.follow_path(np.full(30, 20.0))
    assert p.min() >= CW / 2 - 1e-6
    p = fr.follow_path(np.full(30, 1270.0))
    assert p.max() <= W - CW / 2 + 1e-6


def test_tracks_reset_at_jump_cuts_and_live_in_source_time():
    segs = [[100.0, 105.0], [200.0, 204.0]]          # reel: 0-5 s from 100 s, 5-9 s from 200 s
    cx = samples(lambda t: 400 if t < 5 else 900, 9)
    crops, tracks = fr.follow_tracks(cx, [], [5.0], 9.0, segs)
    assert [(c["t0"], c["t1"]) for c in crops] == [(0.0, 5.0), (5.0, 9.0)]
    assert [c["z"] for c in crops] == [1.0, fr.PUNCH]
    assert all(c["cw"] == CW and c["cx"] == c["ax"] for c in crops)
    assert [(tr["s"], tr["e"]) for tr in tracks] == [(100.0, 105.0), (200.0, 204.0)]
    assert fr.follow_at(tracks, 102.0) == pytest.approx(400, abs=fr.DEAD)
    assert fr.follow_at(tracks, 203.0) == pytest.approx(900, abs=fr.DEAD)
    assert fr.follow_at(tracks, 150.0) is None


def test_x_at_follows_the_path_and_keeps_a_manual_nudge():
    segs = [[100.0, 110.0]]
    cx = samples(lambda t: 300 + 60 * t, 10)        # walks right the whole clip
    crops, tracks = fr.follow_tracks(cx, [], [], 10.0, segs)
    c = dict(crops[0])
    a, b = fr.x_at(c, 1.0, "follow", tracks, segs, [0.0]), fr.x_at(c, 8.0, "follow", tracks, segs, [0.0])
    assert b - a > 300
    assert fr.x_at(c, 8.0, "fixed", tracks, segs, [0.0]) == c["cx"]
    c["cx"] = c["ax"] + 25                            # editor dragged the crop 25 px right
    assert fr.x_at(c, 8.0, "follow", tracks, segs, [0.0]) == pytest.approx(b + 25)


def test_editor_trim_keeps_the_path_on_the_same_source_moment():
    segs = [[100.0, 110.0]]
    cx = samples(lambda t: 300 + 60 * t, 10)
    crops, tracks = fr.follow_tracks(cx, [], [], 10.0, segs)
    at_105 = fr.x_at(crops[0], 5.0, "follow", tracks, segs, [0.0])
    trimmed = [[103.0, 110.0]]                          # editor trimmed 3 s off the head
    assert fr.x_at(crops[0], 2.0, "follow", tracks, trimmed, [0.0]) == pytest.approx(at_105)


def test_fixed_mode_crops_carry_the_follow_anchor():
    cx = samples(lambda t: 500.0, 6)
    fcrops, _ = fr.follow_tracks(cx, [], [], 6.0, [[0.0, 6.0]])
    scrops = fr.static_crops(cx, [], [], 6.0)
    assert len(fcrops) == len(scrops) == 1
    assert scrops[0]["cx"] == pytest.approx(fcrops[0]["ax"], abs=1)
