"""aipics: every cutaway that needs a picture gets a NEW AI one (scene in English from the sermon line, then a
picture), failures keep their `need`, replace=True redoes library pictures too; the service is called with a UA."""
import json

import pytest

from viku import aipics


def reel():
    return {"id": "p1~2", "title": "His family", "language": "or",
            "captions": [{"t0": 0, "t1": 3, "text": "ଲାଇନ ଏକ"}, {"t0": 3, "t1": 6, "text": "ଲାଇନ ଦୁଇ"}],
            "cutaways": [{"t0": 1, "t1": 4, "img": None, "text": "ଲାଇନ ଏକ",
                          "need": {"text": "ଲାଇନ ଏକ", "tags": ["family"], "grade": "warm golden-hour grade"}},
                         {"t0": 8, "t1": 11, "img": "lib/old.png", "lib_id": "old", "text": "ଲାଇନ ଦୁଇ"},
                         {"t0": 14, "t1": 17, "img": None, "text": "ଲାଇନ ତିନି", "need": {"text": "ଲାଇନ ତିନି"}}]}


@pytest.fixture
def world(monkeypatch, tmp_path):
    state = {"p": {"name": "Sermon", "reels": [reel()]}, "imports": [], "prompts": []}
    monkeypatch.setattr(aipics, "ready", lambda: True)
    monkeypatch.setattr(aipics.projects, "find_reel", lambda rid: (state["p"], state["p"]["reels"][0]))
    monkeypatch.setattr(aipics.projects, "reel_dir", lambda rid: tmp_path)

    def update(pid, fn):
        fn(state["p"])
    monkeypatch.setattr(aipics.projects, "update", update)
    monkeypatch.setattr(aipics, "scene", lambda line, lang, around, title, used=None: f"scene for {line}")

    def picture(prompt, out):
        state["prompts"].append(prompt)
        if "ତିନି" in prompt:
            raise RuntimeError("quota")
        f = out.with_suffix(".jpg")
        f.write_bytes(b"\xff\xd8" + b"0" * 3000)
        return f, "sdxl"
    monkeypatch.setattr(aipics, "picture", picture)

    def import_paths(paths, tags, desc="", setname=""):
        state["imports"].append({"path": paths[0], "tags": tags, "desc": desc, "set": setname})
        return {"ids": [f"new{len(state['imports'])}"]}
    monkeypatch.setattr(aipics.library, "import_paths", import_paths)
    monkeypatch.setattr(aipics.library, "items", lambda: [{"id": f"new{k + 1}", "path": f"lib/new{k + 1}.jpg"}
                                                         for k in range(len(state["imports"]))])
    return state


def test_fill_makes_new_pictures_for_needs_and_keeps_failures(world):
    res = aipics.fill("p1~2")
    cs = world["p"]["reels"][0]["cutaways"]
    assert res["made"] == 1 and res["failed"] == 1
    assert cs[0]["img"] == "lib/new1.jpg" and "need" not in cs[0] and cs[0]["need_done"]["tags"] == ["family"]
    assert cs[0]["ai"]["scene"] == "scene for ଲାଇନ ଏକ" and cs[0]["ai"]["model"] == "sdxl"
    assert cs[1]["img"] == "lib/old.png"                      # library picture untouched without replace
    assert cs[2]["img"] is None and cs[2]["need"]             # failed one stays a request
    assert "warm golden-hour grade" in world["prompts"][0] and "no text" in world["prompts"][0]
    assert world["imports"][0]["set"] == "Sermon reel 2 (AI)" and "family" in world["imports"][0]["tags"]


def test_fill_replace_redoes_library_pictures(world):
    res = aipics.fill("p1~2", replace=True)
    cs = world["p"]["reels"][0]["cutaways"]
    assert res["made"] == 2
    assert cs[1]["img"].startswith("lib/new") and cs[1]["ai"]["scene"] == "scene for ଲାଇନ ଦୁଇ"


def test_post_sends_auth_and_a_user_agent(monkeypatch):
    seen = {}
    monkeypatch.setattr(aipics, "cfg", lambda: {"url": "https://w.example.dev/", "key": "k1", "text_model": "llama"})

    class R:
        headers = {"Content-Type": "application/json"}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps({"response": "Scene: An Indian family prays together at dawn."}).encode()

    def urlopen(req, timeout):
        seen.update(url=req.full_url, auth=req.get_header("Authorization"), ua=req.get_header("User-agent"),
                    body=json.loads(req.data))
        return R()
    monkeypatch.setattr(aipics.urllib.request, "urlopen", urlopen)
    assert aipics.scene("ଲାଇନ", "or", "", "T") == "An Indian family prays together at dawn."
    assert seen["url"] == "https://w.example.dev/text" and seen["auth"] == "Bearer k1"
    assert seen["ua"].startswith("Viku/") and "Odia" in seen["body"]["messages"][0]["content"]


def test_not_set_up_is_refused(monkeypatch):
    monkeypatch.setattr(aipics, "cfg", lambda: {"url": "", "key": ""})
    with pytest.raises(aipics.NotSetUp):
        aipics.scene("x", "or")
