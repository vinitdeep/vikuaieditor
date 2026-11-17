"""Caption fixer, ranker scoring, cutaway planner house rules, hook titles - offline (no e5, empty library)."""
import numpy as np
import pytest

from viku.brain import captions, cutaways, embed, hooks, ranker


@pytest.fixture(autouse=True)
def no_embeddings(monkeypatch):
    """Keep the brain offline and fast: no e5 model (hook / matcher fall back to lexical scoring)."""
    monkeypatch.setattr(embed, "available", lambda: False)


# ------------------------------------------------------------------ caption fixer --
def test_caption_fixer_applies_safe_dictionary_fix_and_flags_it():
    r = captions.fix("ଜିଶୁ ଆପଣଙ୍କୁ ଭଲ ପାଆନ୍ତି", "or")
    assert r["text"].startswith("ଯୀଶୁ ")
    f = r["flags"][0]
    assert f["reason"] == "corrected" and f["suggest"] == "ଜିଶୁ"
    assert r["text"][f["start"]:f["end"]] == "ଯୀଶୁ"


def test_caption_fixer_never_rewrites_plain_speech():
    txt = "आप अकेले नहीं हैं"
    r = captions.fix(txt, "hi")
    assert r["text"] == txt
    assert all(f["reason"] != "corrected" for f in r["flags"])


def test_caption_fixer_flags_rnnt_ctc_disagreement():
    r = captions.fix("God is with you", "en", alt="God is with us")
    dis = [f for f in r["flags"] if f["reason"] == "rnnt_ctc_disagree"]
    assert dis and dis[0]["suggest"] == "us"
    assert r["text"][dis[0]["start"]:dis[0]["end"]] == "you"


def test_caption_fixer_learns_from_an_edit():
    pairs = captions.learn_edit("ମୋର ପ୍ରଭୁ ଜିସସ", "ମୋର ପ୍ରଭୁ ଯୀଶୁ", "or")
    assert pairs == [("ଜିସସ", "ଯୀଶୁ")]
    r = captions.fix("ଜିସସ ଆସୁଛନ୍ତି", "or")
    assert r["text"] == "ଯୀଶୁ ଆସୁଛନ୍ତି"
    captions.rebuild_memory([])  # leave the memory empty for other tests


# ------------------------------------------------------------------ ranker --
def _window(texts, start=0.0, step=4.0, conf=0.9, lang="hi"):
    return [{"start": start + i * step, "end": start + (i + 1) * step - 0.3, "text": t, "conf": conf, "lang": lang}
            for i, t in enumerate(texts)]


def test_ranker_scores_hope_above_announcement():
    m = ranker.seed_model()
    assert m and len(m["features"]) == len(m["weights"])
    good = _window(["आप अकेले नहीं हैं", "परमेश्वर आपके साथ है", "आप सब कुछ कर सकते हैं", "मत डरो, विजय आपकी है",
                    "यीशु आपसे प्रेम करता है", "आशा मत छोड़ो"] * 2)
    notice = _window(["अगले रविवार की मीटिंग", "कृपया अपना नाम लिखवाएं", "घोषणा सुनिए", "ऑफरिंग के लिए",
                      "मीटिंग शाम को है", "धन्यवाद"] * 2)
    R = np.array([[ranker.raw_features(w, "hi")[k] for k in ranker.RAW] for w in (good, notice)])
    dim = len(m["centroid_pos"])
    E = np.tile(np.ones(dim, np.float32) / np.sqrt(dim), (2, 1))   # identical meaning: only the features differ
    p, contrib = ranker.score(R, E, m)
    assert 0 < p[1] < p[0] < 1
    assert contrib.shape == (2, len(m["features"]))
    why = ranker.reasons(contrib[0], m)
    assert why and all(r["contribution"] > 0 for r in why)


def test_raw_features_pace_and_duration_fit():
    w = _window(["a b c d"] * 10, step=4.5)
    f = ranker.raw_features(w, "en")
    assert f["duration_fit"] == pytest.approx(max(0.0, 1 - abs((w[-1]["end"] - w[0]["start"]) - 45) / 25))
    assert np.isnan(f["energy"])            # no audio -> NaN, z-scored to 0 later
    assert f["asr_conf"] == pytest.approx(0.9)


# ------------------------------------------------------------------ cutaway planner --
def _caps(n=14, step=3.4):
    lines = ["Satan wanted to defeat you", "but Jesus rose again", "the tomb is empty today",
             "why are you still afraid?", "he carried the cross for you", "the storm will pass",
             "pray with your family tonight", "your chains are broken now", "walk in the light of God",
             "the Bible says do not fear", "lift your hands and praise", "He gives strength to the weak",
             "you are never alone again", "You can do all things through Christ"]
    return [{"t0": round(i * step + 0.1, 3), "t1": round((i + 1) * step - 0.1, 3), "text": lines[i % len(lines)]}
            for i in range(n)]


def test_cutaway_plan_keeps_house_rules():
    caps = _caps()
    dur = caps[-1]["t1"] + 0.3
    plan = cutaways.plan(caps, dur, "en", jumps=[10.2, 27.1])
    assert plan, "a 47 s reel gets cutaways"
    assert cutaways.check(plan, dur) == []                  # gaps >= 0.75 s, 2.5-5.5 s, no hook, pans <= 80
    assert all(c["t0"] >= cutaways.HOOK_MIN for c in plan)   # speaker for the 0-4 s title hook
    last = caps[-1]
    assert all(c["t1"] <= last["t0"] + 0.35 for c in plan)  # closing line stays on the speaker
    gaps = [b["t0"] - a["t1"] for a, b in zip(plan, plan[1:])]
    assert all(g < 1e-3 or g >= cutaways.MIN_GAP for g in gaps)
    cov = cutaways.coverage(plan, dur)
    assert 0.3 <= cov <= cutaways.COVER_HI + 0.02
    # empty library: every cutaway is a generation request with a usable prompt
    assert all(c["img"] is None and c["need"]["prompt"].startswith("VERTICAL 9:16") for c in plan)
    zs = [(c["z0"], c["z1"]) for c in plan]
    assert all(a != b for a, b in zs) and zs[0] == (1.12, 1.22)  # alternating push-in / pull-out


def test_cutaway_check_catches_violations():
    bad = [{"t0": 2.0, "t1": 6.0, "pan": [0, 0]}, {"t0": 6.4, "t1": 12.5, "pan": [100, 0]}]
    errs = cutaways.check(bad, 30)
    assert any("title hook" in e for e in errs)
    assert any("speaker flash" in e for e in errs)
    assert any("length" in e for e in errs)
    assert any("pan" in e for e in errs)


def test_cutaway_plan_skips_tiny_reels():
    assert cutaways.plan(_caps(2), 6.0, "en") == []


# ------------------------------------------------------------------ hook titles --
def test_hook_title_avoids_the_enemy_as_subject():
    lines = ["କ୍ରୁଶୀୟ ମୃତ୍ୟୁ ଯଶୁଙ୍କର ମୃତ୍ୟୁରେ ଶୟତାନ ନି", "ନିଜକୁ ବିଜୟୀ ମନେ କରିଥିଲା କିନ୍ତୁ",
             "କିନ୍ତୁ ପୁନରୁତ୍ଥାନ ହେଲା ପରେ ତାହାର", "ଚୂଡ଼ାନ୍ତ ପରାଜୟ ସମ୍ଭବ କଲା", "ସମାପ୍ତ କଲା"]
    hk = hooks.hook(lines, "or")
    assert "ବିଜୟୀ ମନେ" not in hk["title"]       # "considered himself victorious" is Satan speaking
    assert "ପରାଜୟ" in hk["title"]


def test_hook_enemy_penalty_rules():
    assert hooks.enemy_penalty("शैतान जीत गया", "hi", True, False) == hooks.ENEMY_SPAN
    assert hooks.enemy_penalty("शैतान हार गया", "hi", True, True) == 0.0
    assert hooks.enemy_penalty("खुद को विजयी समझा", "hi", True, False) == hooks.ENEMY_CONTEXT
    assert hooks.enemy_penalty("यीशु विजयी है", "hi", True, False) == 0.0   # God is the subject
    assert not hooks.enemy_defeated("ଲୁସିଫର୍ ଆପଣଙ୍କୁ ହରାଇବାକୁ ଚାହିଁବ", "or")  # "wants to defeat you" is no defeat


def test_fallback_never_makes_a_canned_claim():
    # every line is about Lucifer and none states his defeat: no "ଶୟତାନ ପରାଜିତ!" and no "enemy is defeated" sub
    lines = [{"text": "ଲୁସିଫର୍ ଇଭେନ୍ ଆଜି ମଧ୍ୟ", "conf": 0.9}, {"text": "ଏଇଟା ଲୁସିଫର୍ ଆପଣଙ୍କ ଜୀବନରେ ଆଣିଥାଏ", "conf": 0.9},
             {"text": "କେଉଁଠାରୁ କେତେ ବର୍ଷ ପର୍ଯ୍ୟନ୍ତ", "conf": 0.6}]
    hk = hooks.hook(lines, "or")
    words = {w for x in lines for w in x["text"].split()}
    assert hk["title"] != "ଶୟତାନ ପରାଜିତ!"
    assert set(hk["title"].rstrip("?!").split()) <= words      # built from the reel's own words
    assert not hk["title"].endswith("!")
    assert "enemy is defeated" not in hk["sub"].lower()


def test_fallback_uses_strongest_own_line_or_verse_ref():
    weak = [{"text": "ଓକେ କୋଟି କୋଟି ବର୍ଷର ବି", "conf": 0.86, "flags": [1]},
            {"text": "ସମସ୍ତ ବିଷୟ ବହୁତ ସୁନ୍ଦର ଭାବରେ ପ୍ରଭୁ ତିଆରି କରିଥିଲେ", "conf": 0.89},
            {"text": "ତ", "conf": 0.5}]
    fb = hooks.fallback_line(weak, "or", [x["text"] for x in weak])
    assert fb and fb[2] == 1 and fb[1].endswith("ତିଆରି କରିଥିଲେ") and len(fb[1].split()) <= 6
    # nothing usable (low confidence everywhere) + a verse card -> the verse's own reference
    junk = [{"text": "ତକୋ ହ କା", "conf": 0.5}, {"text": "କା ଯୋ ଭଏସ ହ", "conf": 0.4}]
    hk = hooks.hook(junk, "or", [{"ref": "ଆଦି ପୁସ୍ତକ 1:1 · Genesis 1:1"}])
    assert hk["title"] == "ଆଦି ପୁସ୍ତକ 1:1" and hk["why"]["fallback"] == "verse"


def test_enemy_subject_is_carried_two_captions():
    t = ["ଯଶୁଙ୍କର ମୃତ୍ୟୁରେ ଶୟତାନ ନି", "ନିଜକୁ ବିଜୟୀ ମନେ କରିଥିଲା", "ଆଉ ଖୁସି ହେଲା", "ଶେଷରେ ଏହା ହେଲା"]
    assert hooks.enemy_context(t, 1, "or") and hooks.enemy_context(t, 2, "or")
    assert not hooks.enemy_context(t, 3, "or")                    # 3 captions later: no longer carried
    t2 = ["ଶୟତାନ ଆସିଲା", "ଆମେ ବିଜୟୀ ହୋଇଛୁ"]                     # a new explicit subject ends the carry
    assert not hooks.enemy_context(t2, 1, "or")
    assert hooks.enemy_context(["शैतान चाहता है कि", "उनको आज हराना चाहता है"], 1, "hi")
    assert not hooks.enemy_context(["शैतान चाहता है कि", "आप विजयी हैं"], 1, "hi")
    # the carried line never becomes the title, the line stating his defeat does
    hk = hooks.hook(["ଯଶୁଙ୍କର ମୃତ୍ୟୁରେ ଶୟତାନ ନି", "ନିଜକୁ ବିଜୟୀ ମନେ କରିଥିଲା", "କିନ୍ତୁ ପୁନରୁତ୍ଥାନ ହେଲା",
                     "ଚୂଡ଼ାନ୍ତ ପରାଜୟ ସମ୍ଭବ କଲା"], "or")
    assert "ବିଜୟୀ" not in hk["title"] and "ପରାଜୟ" in hk["title"]


def test_asr_quality_gate():
    assert hooks.agreement("सो मु कौन कह", "सो मु कण कही") < hooks.AGREE_MIN               # garbled decode
    assert hooks.agreement("ଚୂଡ଼ାନ୍ତ ପରାଜୟ ସମ୍ଭବ କଲା", "ଚୂଡ଼ାନ୍ତ ପରାଜୟ ସମ୍ଭ୍ରତ କଲା") >= hooks.AGREE_MIN
    assert hooks.agreement("मैं क्या कर सकूँगा", "मैं क्या कर सकूंगा") == 1.0             # spelling variant only
    assert hooks.agreement("God is with you", None) is None
    vocab = {"परमेश्वर", "आपके", "साथ", "है", "आप", "अकेले", "नहीं", "हैं"}
    ok = lambda text, lang="hi", alt=None: hooks.line_quality({"text": text, "alt": alt}, lang, vocab)[0]  # noqa: E731
    assert ok("परमेश्वर आपके साथ है")
    assert not ok("परमेश्वर साथ")                                    # < 3 words
    assert not ok("ଆପ ସୋଚ ଲିଜେ କି", "hi")                            # Odia script in a Hindi reel
    assert not ok("परमेश्वर क़ुर्बत बेखु जिते")                      # < 70 % known words
    assert not ok("परमेश्वर आपके साथ है", alt="पर मेश आप के सा")       # RNNT / CTC disagree


def test_no_gated_line_gives_verse_ref_or_neutral_name_for_review():
    junk = [{"text": "सो मु कौन कह", "alt": "सो मु कण कही"}, {"text": "देखू से कौन कवा जाए", "alt": "देखू सेतब कण क जाए"}]
    hk = hooks.hook(junk, "hi", [{"ref": "यूहन्ना 15:5 · John 15:5"}])
    assert hk["title"] == "यूहन्ना 15:5" and hk["title_flag"] == "review"
    hk = hooks.hook(junk, "hi", [], fallback_name="Before the Foundation · Reel 3")
    assert hk["title"] == "Before the Foundation · Reel 3" and hk["title_flag"] == "review"
    good = hooks.hook([{"text": "आप अकेले नहीं हैं", "alt": "आप अकेले नहीं हैं"}] * 2, "hi")
    assert good["title_flag"] is None and "अकेले" in good["title"]


def test_suggest_titles_use_the_gate_and_clip_fallback():
    from viku.brain import clipfinder
    junk = [{"start": 0, "end": 2, "text": "सो मु कौन कह", "alt": "सो मु कण कही"},
            {"start": 2, "end": 4, "text": "देखू से कौन कवा जाए", "alt": "देखू सेतब कण क जाए"}]
    title, flag = clipfinder.pick_title(junk, "hi", [], "Before the Foundation · Clip 2")
    assert (title, flag) == ("Before the Foundation · Clip 2", "review")
    good = [{"start": 0, "end": 2, "text": "आप अकेले नहीं हैं", "alt": "आप अकेले नहीं हैं"},
            {"start": 2, "end": 4, "text": "परमेश्वर आपके साथ है", "alt": "परमेश्वर आपके साथ है"}]
    title, flag = clipfinder.pick_title(good, "hi", [], "X · Clip 1")
    assert flag is None and title and "Clip" not in title
    assert clipfinder._short_name({"name": "ମୂଳଦୁଆ ପୂର୍ବରୁ _ Before the Foundation _ Pastor"}) == "ମୂଳଦୁଆ ପୂର୍ବରୁ"
