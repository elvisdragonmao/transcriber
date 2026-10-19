import numpy as np

from transcriber_worker.align import aligner_language, fallback_words, locate_words
from transcriber_worker.checkpoint import Checkpoint, fingerprint
from transcriber_worker.segmentation import Span, build_segments
from transcriber_worker.textnorm import looks_degenerate, parse_vocabulary, to_traditional

SR = 16000


def _audio(seconds, quiet_at=()):
    rng = np.random.default_rng(0)
    a = rng.normal(0, 0.1, int(seconds * SR)).astype(np.float32)
    for q in quiet_at:
        a[int(q * SR) : int((q + 0.3) * SR)] = 0.0
    return a


def test_merges_close_spans_and_keeps_absolute_times():
    a = _audio(20)
    spans = [Span(1 * SR, 3 * SR), Span(int(3.5 * SR), 6 * SR), Span(12 * SR, 14 * SR)]
    segs = build_segments(spans, a, SR, len(a), max_len_s=28, max_gap_s=1.2)
    assert [(s.start / SR, s.end / SR) for s in segs] == [(1, 6), (12, 14)]


def test_long_span_split_at_quiet_point_under_limit():
    a = _audio(70, quiet_at=(25,))
    segs = build_segments([Span(0, 70 * SR)], a, SR, len(a), max_len_s=28)
    assert all(s.end - s.start <= 28 * SR for s in segs)
    assert abs(segs[0].end / SR - 25.15) < 0.4  # cut inside the silent gap
    assert segs[0].start == 0 and segs[-1].end == 70 * SR
    for x, y in zip(segs, segs[1:]):
        assert x.end == y.start  # contiguous, nothing dropped


def test_short_segment_padded_but_not_overlapping_neighbours():
    a = _audio(10)
    segs = build_segments([Span(1 * SR, 2 * SR), Span(int(5 * SR), int(5.2 * SR))], a, SR, len(a), min_len_s=1.0, max_gap_s=0.5)
    assert segs[1].end - segs[1].start >= 0.99 * SR
    assert segs[1].start >= segs[0].end


def test_traditional_conversion_protects_english_and_vocab():
    out = to_traditional("我们用Qwen3做语音识别，软件叫做语音识别器", "s2twp", protect=["语音识别器"])
    assert "Qwen3" in out
    assert out.startswith("我們")
    assert out.endswith("语音识别器")


def test_vocab_parsing():
    assert parse_vocabulary("ICT, 創創工坊\nQwen；Qwen") == ["ICT", "創創工坊", "Qwen"]


def test_degenerate_detection():
    assert looks_degenerate("哈哈哈哈哈哈" * 40, 3)
    assert not looks_degenerate("今天天氣很好，我們來討論專案。", 4)


def test_locate_words_and_language():
    text = "我們用 Qwen3-ASR，好嗎？"
    words = ["我", "們", "用", "Qwen3-ASR", "好", "嗎"]
    offs = locate_words(text, words)
    assert offs[3] == (4, 13)
    assert all(o[0] is not None for o in offs)
    assert aligner_language("Chinese", text) == "Chinese"
    assert aligner_language("", "hello") == "English"
    fw = fallback_words("hello 世界", 1000)
    assert len(fw) == 3 and fw[-1]["re"] == 1000 and not fw[0]["aligned"]


def test_checkpoint_rejects_mismatched_fingerprint(tmp_path):
    p = str(tmp_path / "ck.json")
    ck = Checkpoint(p, "asr", fingerprint({"a": 1}))
    ck.put(0, {"x": 1})
    ck.flush()
    assert Checkpoint(p, "asr", fingerprint({"a": 1})).resumed == 1
    assert Checkpoint(p, "asr", fingerprint({"a": 2})).resumed == 0
    assert Checkpoint(p, "align", fingerprint({"a": 1})).resumed == 0
