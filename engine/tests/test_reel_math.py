"""Jump-cut segment remap + the true-peak loudness guard (pure functions of media/reel.py)."""
import pytest

from viku.media import reel

SEGS = [[100.0, 110.0], [120.0, 125.5], [130.0, 140.0]]


def test_segment_offsets_are_the_joins():
    assert reel.segment_offsets(SEGS) == [0.0, 10.0, 15.5]
    assert reel.segment_offsets([]) == []


@pytest.mark.parametrize("src,expected", [(100.0, 0.0), (105.0, 5.0), (110.0, 10.0), (120.0, 10.0), (123.0, 13.0),
                                          (131.0, 16.5), (140.0, 25.5)])
def test_src_to_reel(src, expected):
    assert reel.src_to_reel(src, SEGS) == pytest.approx(expected)


def test_src_to_reel_inside_a_removed_part_is_none():
    assert reel.src_to_reel(115.0, SEGS) is None
    assert reel.src_to_reel(99.0, SEGS) is None


@pytest.mark.parametrize("t", [0.0, 3.3, 9.99, 10.0, 12.0, 15.5, 20.0, 25.5])
def test_reel_to_src_roundtrip(t):
    s = reel.reel_to_src(t, SEGS)
    assert reel.src_to_reel(s, SEGS) == pytest.approx(t, abs=1e-3)


def test_reel_to_src_clamps():
    assert reel.reel_to_src(-1, SEGS) == 100.0
    assert reel.reel_to_src(99, SEGS) == 140.0


def test_loudness_guard():
    assert reel.tp_guard_gain(None, -1.5) is None
    assert reel.tp_guard_gain(-1.9, -1.5) is None
    assert reel.tp_guard_gain(-1.5, -1.5) is None           # exactly at the limit is fine
    g = reel.tp_guard_gain(-0.8, -1.5)                      # AAC overshoot of 0.7 dB
    assert g == pytest.approx(-0.9)                         # pulled under the limit with a 0.2 dB margin
    assert -0.8 + g <= -1.5
