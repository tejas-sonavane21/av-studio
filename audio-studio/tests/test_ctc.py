"""
align/ctc.py — the forced-alignment core.

The whole point of this module being pure is that the *algorithm* can be tested
against hand-built emission matrices instead of against a 360 MB acoustic model.
Every assertion here is an exact number or an exact path, which is what makes a
later change to the trellis fail loudly instead of quietly moving every word in
every transcript by 20 ms.
"""

from __future__ import annotations

import math

import pytest

from audio_studio.align.ctc import (
    MAX_CELLS,
    NEG_INF,
    AlignmentError,
    forced_align,
    group_spans,
    log_softmax,
    merge_repeats,
    predecessors,
    token_at,
)


def frame(weights: dict[int, float], channels: int = 3) -> list[float]:
    """One frame of logits, with the given weight on the given labels."""
    row = [0.0] * channels
    for label, weight in weights.items():
        row[label] = weight
    return log_softmax(row)


def peaked(labels: list[int], channels: int = 3, sharp: float = 8.0) -> list[list[float]]:
    """
    Emissions built from a known **symbol** sequence: frame ``t`` strongly prefers
    ``labels[t]``. Symbols, not trellis states — the state path is what the
    alignment has to *derive*, so building the input from it would be circular.
    """
    return [frame({label: sharp}, channels) for label in labels]


# --------------------------------------------------------------------------- #
# the helpers
# --------------------------------------------------------------------------- #


def test_log_softmax_is_a_distribution():
    row = log_softmax([1.0, 2.0, 3.0])
    assert math.isclose(sum(math.exp(value) for value in row), 1.0, rel_tol=1e-12)


def test_log_softmax_survives_big_and_impossible_frames():
    huge = log_softmax([1000.0, 1001.0])
    assert math.isfinite(huge[0]) and math.isfinite(huge[1])
    assert log_softmax([NEG_INF, NEG_INF]) == [NEG_INF, NEG_INF]


def test_even_states_are_blank_and_odd_states_are_targets():
    targets = [7, 8]
    assert token_at(0, targets) == 0
    assert token_at(1, targets) == 7
    assert token_at(2, targets) == 0
    assert token_at(3, targets) == 8


def test_predecessors_never_skip_a_blank_state():
    assert predecessors(0, []) == (0,)
    assert predecessors(2, [1, 2]) == (2, 1)


def test_predecessors_skip_two_only_between_two_different_labels():
    # 'tt' in "letter": arriving at the second t straight from the first would
    # collapse the two into one symbol, so the skip must not be offered.
    assert predecessors(3, [1, 2]) == (3, 2, 1)
    assert predecessors(3, [1, 1]) == (3, 2)


def test_predecessors_offer_staying_first_which_is_the_tie_break():
    """Ties must be reproducible, so the order is part of the contract."""
    for state, targets in ((0, []), (1, [1]), (2, [1, 2]), (3, [1, 2])):
        assert predecessors(state, targets)[0] == state


# --------------------------------------------------------------------------- #
# forced_align
# --------------------------------------------------------------------------- #


def test_a_hand_built_trellis_walks_the_obvious_path():
    emissions = [frame({0: 3.0}), frame({1: 3.0}), frame({2: 3.0})]
    path, score = forced_align(emissions, [1, 2], blank=0)
    # frame 0 on the leading blank, frame 1 on 'a', frame 2 on 'b'
    assert path == [0, 1, 3]
    assert score > -0.5


def test_a_path_is_recovered_exactly_when_the_emissions_are_clear():
    # Symbols per frame, and the trellis states they can only have come from:
    # blank, a, a, blank, b, b, blank, a  →  states 0, 1, 1, 2, 3, 3, 4, 5
    designed = [0, 1, 1, 0, 2, 2, 0, 1]
    expected = [0, 1, 1, 2, 3, 3, 4, 5]
    targets = [1, 2, 1]
    path, _score = forced_align(peaked(designed), targets, blank=0)
    assert path == expected
    # merge_repeats reports label *positions*; the labels themselves are the targets
    assert [targets[repeat[0]] for repeat in merge_repeats(path)] == [1, 2, 1]


def test_every_target_gets_at_least_one_frame():
    targets = [1, 2, 3, 4]
    path, _score = forced_align(peaked([0, 1, 2, 0, 3, 4], channels=5), targets, blank=0)
    repeats = merge_repeats(path)
    assert [targets[repeat[0]] for repeat in repeats] == [1, 2, 3, 4]
    assert len(repeats) == 4


def test_a_repeated_label_keeps_its_two_occurrences_apart():
    targets = [1, 1]
    emissions = peaked([0, 1, 0, 1, 0])
    path, _score = forced_align(emissions, targets, blank=0)
    repeats = merge_repeats(path)
    assert [targets[repeat[0]] for repeat in repeats] == [1, 1]
    # the blank really is between them, which is the only way CTC can spell 'tt'
    assert repeats[0][2] < repeats[1][1]


def test_the_path_is_always_non_decreasing():
    """This is what makes the resulting word spans non-overlapping for free."""
    emissions = peaked([0, 1, 0, 2, 2, 0, 1, 0], channels=3, sharp=0.2)
    path, _score = forced_align(emissions, [1, 2, 1], blank=0)
    assert all(a <= b for a, b in zip(path, path[1:]))


def test_noisy_emissions_still_produce_a_usable_alignment():
    targets = [1, 2]
    emissions = [frame({0: 0.1, 1: 0.1, 2: 0.1}) for _ in range(6)]
    path, score = forced_align(emissions, targets, blank=0)
    assert len(path) == 6
    assert [targets[repeat[0]] for repeat in merge_repeats(path)] == [1, 2]
    assert math.isfinite(score)


def test_an_empty_window_aligns_to_nothing():
    assert forced_align([], [1, 2]) == ([], NEG_INF)


def test_no_targets_means_every_frame_is_blank():
    emissions = peaked([0, 0, 0])
    path, _score = forced_align(emissions, [], blank=0)
    assert path == [0, 0, 0]
    assert merge_repeats(path) == []


def test_the_result_is_reproducible():
    emissions = peaked([0, 1, 0, 2, 1, 0], channels=3, sharp=0.4)
    assert forced_align(emissions, [1, 2, 1]) == forced_align(emissions, [1, 2, 1])


def test_an_absurd_window_is_refused_rather_than_allocated():
    emissions = [[0.0, 0.0] for _ in range(10)]
    with pytest.raises(AlignmentError):
        forced_align(emissions, list(range(MAX_CELLS)), blank=0)


# --------------------------------------------------------------------------- #
# merge_repeats / group_spans
# --------------------------------------------------------------------------- #


def test_merge_repeats_drops_blanks_and_groups_runs():
    # Every odd state is a target; every even state is a blank and is dropped.
    # State 1 is target 0 and state 3 is target 1, which is why the last two
    # entries share a label index.
    assert merge_repeats([0, 0, 1, 1, 2, 3, 3, 0]) == [(0, 2, 3), (1, 5, 6)]


def test_group_spans_gives_each_word_the_span_of_its_own_labels():
    repeats = merge_repeats([0, 1, 0, 3, 3, 0, 5])
    spans = group_spans(repeats, [[0, 1], [2]], [1, 3, 5])
    assert spans == [(1, 4), (6, 6)]


def test_group_spans_returns_none_for_a_group_with_no_labels():
    repeats = merge_repeats([0, 1, 0])
    assert group_spans(repeats, [[0], []], [1]) == [(1, 1), None]


def test_group_spans_refuses_a_path_that_does_not_visit_every_label():
    with pytest.raises(AlignmentError):
        group_spans(merge_repeats([0, 1]), [[0], [1]], [1, 2])
