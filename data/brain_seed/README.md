# Viku Brain — training seed (2026-11-17)

This is the seed data for the offline clip finder (see `ARCHITECTURE.md` → "Offline AI"). It comes from two Pastor Jacob Deep sermons at TAPP Church Hirakud:

| id | sermon | language | source transcript (absolute source seconds) |
|---|---|---|---|
| `btf` | ମୂଳଦୁଆ ପୂର୍ବରୁ / Before the Foundation | Odia + Hindi | `Downloads\Before the Foundation reels\_work\cues_abs.json` (Odia ASR) and `cues_hi_abs.json` (Hindi ASR of the same audio), 2880–8200 s: notices, sermon, closing prayer |
| `salvation` | Salvation / ପରିତ୍ରାଣ | Odia (a little Hindi) | `Downloads\Salvation _ ପରିତ୍ରାଣ _ … .or.srt` (Odia ASR), 0–5252 s: the whole service, including notices, sermon, communion and worship |

## Files

| file | what it holds |
|---|---|
| `windows.jsonl` | 662 labelled transcript windows, one JSON object per line |
| `window_embeddings.npy` | float32 array [662, 384]. Its row order matches `windows.jsonl`. Each row is the e5 embedding of `"passage: " + text`, L2-normalised |
| `lexicon.json` | Word lists per language (`or`, `hi`, `en`): `victory_encouragement`, `direct_address`, `scripture_books`, `scripture_refs` (chapter, verse and number words), `filler_call_response`, `negative_ending`, plus `enemy`, `admin_notice` and `regex_hints`. ASR spellings are included, e.g. ଆଲୁଆ, ଆଲ ଲୁଆ, ଲୁସିଫର୍, चैतान, सकूंगा |
| `caption_corrections.jsonl` | 115 ASR→caption pairs: `{"lang","wrong","right","n","safe","source","reels"}`. Use `safe:false` pairs (21) only as suggestions, because their `wrong` form is also a real word, e.g. `में→मैं`, `मुख्य→मुँह`, `ବିଷ→ବିଷୟ`, `କୃଷି→କ୍ରୁଶୀୟ` |
| `tools/` | Scripts that rebuild everything (python 3.11 + numpy + onnxruntime + tokenizers), in this order: `build_windows.py` → `label_windows.py` → `embed.py --windows` → `eval_lr.py`; `harvest_corrections.py` → `curate_corrections.py`. `user_labels.py` holds the user verdicts. `seedlib.py` holds the loaders and the Odia/Hindi language-id rules |
| `tools/work/` | Intermediates: `spans_<sermon>_<part>.json` holds the hand-judged spans (contiguous, scored 0/0.3/0.6/0.9 with tags and reasons). `sheet_*.txt` is the judging sheet. Also here: `windows_base.jsonl`, `corrections_raw.jsonl`, `stats.json`, `eval_lr.json` |

## `windows.jsonl` schema

```json
{"id":"btf-7239.60-7283.00","sermon":"btf","start":7239.6,"end":7283.0,
 "lang":"or|hi|mixed","text":"…","text_or_asr":"… (hi/mixed only)",
 "label":0.0-1.0,"source":"user|derived|judged","reasons":["2–4 short English reasons"],
 "user_reel":"hi-1-main-kar-sakunga (user/derived only)","judged_mean":0.83,"tags":["direct_address","victory",…]}
```

- **Windows.** Consecutive cues are joined into windows that start and end only at pauses of at least 0.6 s. A new window starts at most every 10 s (in practice every 10–18 s, because long pauses are sparse), and each start gets two lengths, about 28 s and about 48 s. All windows are 20–60 s. Every user reel range and every jump-cut segment is also added as its own exact window; some segments are only 4–15 s long.
- **lang.** Language id is decided per cue. It combines the Hindi function-word density of the Hindi ASR with the share of Hindi words transliterated into Odia script against Odia function words in the Odia ASR. A window is `hi` when at least 70 % of its speech is Hindi, `or` when at most 30 % is, and `mixed` otherwise.
- **text.** Cues detected as Hindi are written from the Hindi ASR, in Devanagari. All other cues come from the Odia ASR. Salvation has no Hindi ASR, so its Hindi lines stay in Odia script.

## Label policy

1. **user**: the window *is* a reel range the user saw.
   - 1.0 liked: 4-dont-fall-down, hi-1-main-kar-sakunga, hi-4-satan-defeated.
   - 0.9 jump-cut reels built in the liked style: the segments of 6-satan-defeated and hi-6-akele-nahi.
   - 0.7 Salvation reels delivered and accepted: 1-not-by-works, 2-with-what-heart, 3-outside-church, 4-thief-on-the-cross, 5-christ-in-me.
   - 0.4 made but not liked: 1, 2, 3 and 5 of the Odia reels, plus hi-2, hi-3 and hi-5.
   - 0.0 rejected drafts: 1-perfect-creation, 3-one-third-angels, 5-hold-the-word.
2. **derived**: a window whose length lies at least 60 % inside one of those ranges takes that range's label.
3. **judged**: every other window. Each transcript was read in full and cut into contiguous spans (173 spans), scored with this rubric:
   - **0.9 strong reel:** speaks to "you", encouragement or victory over the enemy, punchy, ends on a declaration.
   - **0.6 decent:** an encouraging story or scripture applied to the listener, but weaker.
   - **0.3 weak:** teaching, word studies, backstory, recap.
   - **0.0 bad:** notices, donor prayer lists, crowd Q&A, logistics, technical trouble, worship or prayer, scolding, or ending on fear.

   A window's label is the time-weighted mean of its spans, snapped to {0, 0.3, 0.6, 0.9}. It is 0.9 when at least 50 % of the window sits in a 0.9 span, and it is capped at 0.3 when the last 8 s fall in a 0.0 span. Reasons come from the dominant spans.

The rejected "perfect creation" Hebrew word study (3781–3862 s) is judged 0.0 to agree with the user's rejection; similar word studies elsewhere are judged 0.3. The made-not-liked closing prayer (8098–8166 s) is judged 0.3.

## Counts (662 windows)

| label | 0.0 | 0.3 | 0.4 | 0.6 | 0.7 | 0.9 | 1.0 | total |
|---|---|---|---|---|---|---|---|---|
| or | 184 | 255 | 16 | 38 | 16 | 5 | 6 | 520 |
| hi | 10 | 22 | 9 | 8 | – | 4 | 6 | 59 |
| mixed | 24 | 44 | – | 6 | – | 7 | 2 | 83 |
| **all** | 218 | 321 | 25 | 52 | 16 | 16 | 14 | 662 |

- By sermon: btf 329, salvation 333.
- By source: judged 591, derived 47, user 24.
- Positives (label ≥ 0.6): 98. Negatives (label ≤ 0.3): 539.

## Does the embedding alone separate good from bad?

`tools/eval_lr.py` runs a numpy logistic regression on the 384-d embedding, standardised and class-balanced. It compares labels ≥ 0.6 (98 windows) against labels ≤ 0.3 (539 windows); the 25 windows at 0.4 are left out. AUC by split:

| split | AUC (l2=100, best) | l2=10 | l2=1 |
|---|---|---|---|
| random 5-fold over windows (overlapping windows leak, so optimistic) | **0.94** | 0.94 | 0.94 |
| blocked 5-fold (contiguous 5-min blocks held out, honest) | **0.72** | 0.71 | 0.67 |
| cross-sermon (train one, test other: btf / salvation) | **0.79 / 0.70** | 0.77 / 0.66 | 0.69 / 0.57 |
| untrained baseline: cosine to positive centroid minus cosine to negative centroid, blocked | **0.76** | | |

**What this means.** The embedding carries a real but modest signal, about 0.72–0.79 AUC on unseen parts of a sermon. A strongly regularised model, or the simple liked-minus-rejected centroid contrast, does as well as a free LR. That supports the architecture's plan: use the embedding as one **semantic feature** next to the lexicon, direct-address, scripture, energy and pitch features. Do not use it as the ranker by itself. With 98 positives from two sermons, every `/learn` label will help.

## Caveats

- **Who judged.** Most labels (591 of 662) are my judgement of noisy ASR text, made at span level by four parallel readers using one shared rubric. Only 71 windows carry user verdicts.
- **Salvation 0.7.** The Salvation reels are labelled 0.7 as instructed. The span judges scored "with what heart" and "outside church" only 0.6, because they convict the listener rather than declare victory.
- **Unused clips.** The older clips in `Downloads\Salvation clips\` (1-essence-of-salvation, 2-sincere-heart, 3-confession, 4-christ-in-me) have no recorded verdict, so they are not used.
- **Caption corrections.** The corrections are word-level difflib alignments of raw ASR against the spec captions. Editorial rewrites (grammar, rephrasing, Odia colloquial→formal changes that depend on context) were removed by hand; see `DROP` and `UNSAFE` in `tools/curate_corrections.py`.
