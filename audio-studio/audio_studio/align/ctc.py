"""
align/ctc.py — CTC forced alignment, in the standard library.

This is the algorithm the whole alignment pass rests on, so it is written as a
**pure function of its arguments** with no torch, no numpy and no model: it takes
a matrix of per-frame log-probabilities and a target sequence, and returns the
best-scoring path of symbols through them. Everything else in ``align/`` is
plumbing around this file.

How it works. A CTC path is a sequence of symbols — the label alphabet plus a
*blank* — one per frame, and ``blank`` is what separates two identical labels.
Forcing a path to collapse to a known target sequence means constraining it to
the standard expanded automaton:

    state 0 = blank   state 1 = targets[0]   state 2 = blank   state 3 = targets[1] ...

Even states are blank, odd state ``2k+1`` is ``targets[k]``. From one frame to
the next the path may **stay** in its state (the symbol spans another frame),
**step one** state, or — only between two *different* labels — **skip two**, which
is the transition that lets ``"tt"`` in ``letter`` be sung without a blank frame
between the two ``t``s. Staying in a blank state costs nothing but a frame, so a
word can never be forced to occupy more time than it really does; skipping is
merely available, never required.

Two deliberate choices, both documented where they happen:

* **Ties prefer the shortest jump.** Real log-probabilities almost never tie, but
  when they do the answer must be reproducible, so the preference order is fixed
  rather than left to floating-point luck.
* **The path may end on the last label or the trailing blank.** A CTC collapse
  discards blanks, so a trailing blank is legitimate but never mandatory. Some
  reference implementations require it, which forces a word to stop at least one
  frame before the end of the audio; that is a bias with no justification here.

Memory: the backpointers are one 2- or 4-byte integer per trellis cell rather
than a float, which is what makes it safe to align a whole file at once instead
of only short windows.
"""

from __future__ import annotations

import math
from array import array
from typing import Optional, Sequence

NEG_INF = float("-inf")

#: Refuse absurd input rather than allocating for it. Two million cells is ~8 MB
#: of backpointers and comfortably covers a five-minute file.
MAX_CELLS = 2_000_000

#: A merged run of the same state: ``(target_index, first_frame, last_frame)``.
Repeat = tuple[int, int, int]


class AlignmentError(RuntimeError):
    """The emissions and the target sequence cannot be aligned."""


# --------------------------------------------------------------------------- #
# small pure helpers
# --------------------------------------------------------------------------- #


def log_softmax(row: Sequence[float]) -> list[float]:
    """
    Numerically stable log-softmax of one frame of logits.

    Written out rather than imported so a backend can hand raw logits straight
    over, and so the confidence numbers this module produces are traceable to one
    implementation.
    """
    best = max(row)
    if best == NEG_INF:
        return [NEG_INF] * len(row)
    total = math.fsum(math.exp(value - best) for value in row)
    offset = best + math.log(total)
    return [value - offset for value in row]


def token_at(state: int, targets: Sequence[int], blank: int = 0) -> int:
    """The symbol a trellis state stands for: blank on even states, a target on odd."""
    return blank if state % 2 == 0 else targets[state // 2]


def predecessors(state: int, targets: Sequence[int]) -> tuple[int, ...]:
    """
    States that may transition into ``state``, in preference order.

    The order is the tie-break: ``(stay, step, skip)`` — when two candidates score
    the same, staying put wins, which keeps a label from being handed frames it
    does not need.
    """
    if state == 0:
        return (0,)
    if state % 2 == 0:
        return (state, state - 1)
    order = [state, state - 1]
    # Skipping a state is only legal between two *different* labels: arriving at a
    # target straight from an identical one with no blank between would collapse
    # the two into a single symbol, which is not the path we asked for.
    if state > 1 and targets[state // 2] != targets[state // 2 - 1]:
        order.append(state - 2)
    return tuple(order)


# --------------------------------------------------------------------------- #
# the trellis
# --------------------------------------------------------------------------- #


def forced_align(
    emissions: Sequence[Sequence[float]],
    targets: Sequence[int],
    blank: int = 0,
) -> tuple[list[int], float]:
    """
    Align ``targets`` to ``emissions``.

    :param emissions: ``T`` frames of log-probabilities (already log-softmaxed).
    :param targets: label indices, no blanks, in order.
    :returns: ``(path, score)`` where ``path[t]`` is the trellis state at frame
        ``t`` — strictly non-decreasing, which is what makes the resulting word
        spans inherently non-overlapping.
    """
    frames = len(emissions)
    labels = len(targets)
    states = 2 * labels + 1

    if frames == 0:
        return [], NEG_INF
    if states * frames > MAX_CELLS:
        raise AlignmentError(
            f"alignment window too large: {frames} frames x {states} states "
            f"({states * frames} cells, limit {MAX_CELLS})"
        )

    # Backpointers: one small int per cell. 'h' is a signed 16-bit int, which
    # covers any realistic label count; beyond that, fall back to 'i'.
    back = array("h" if states < 32767 else "i")

    # Frame 0: the path may be on the first blank or already on the first label.
    prev = [NEG_INF] * states
    prev[0] = emissions[0][blank]
    if labels:
        prev[1] = emissions[0][targets[0]]
    back.extend([0] * states)

    for frame in range(1, frames):
        row = emissions[frame]
        current = [NEG_INF] * states
        chosen = [0] * states
        for state in range(states):
            best = NEG_INF
            best_from = state
            for source in predecessors(state, targets):
                value = prev[source]
                if value > best:
                    best, best_from = value, source
            if best != NEG_INF:
                current[state] = best + row[token_at(state, targets, blank)]
            chosen[state] = best_from
        back.extend(chosen)
        prev = current

    # The collapse discards blanks, so ending on either the trailing blank or the
    # last label is a valid alignment of the same targets.
    final = states - 1
    score = prev[final]
    if labels and prev[states - 2] > score:
        final, score = states - 2, prev[states - 2]

    path = [0] * frames
    state = final
    for frame in range(frames - 1, -1, -1):
        path[frame] = state
        if frame:
            state = back[frame * states + state]
    return path, score


def merge_repeats(path: Sequence[int], blank: int = 0) -> list[Repeat]:
    """
    Collapse the path into runs: one entry per label the path actually visits.

    Blank runs are dropped, so ``[(0, 1)]`` means "label 0 covered frames 1..1".
    The result is in frame order, one entry per **occurrence**, which is what makes
    it safe to map back onto a target sequence containing the same label twice.
    """
    out: list[Repeat] = []
    index = 0
    while index < len(path):
        state = path[index]
        end = index
        while end + 1 < len(path) and path[end + 1] == state:
            end += 1
        if state % 2 == 1:
            out.append((state // 2, index, end))
        index = end + 1
    return out


def group_spans(
    repeats: Sequence[Repeat],
    groups: Sequence[Sequence[int]],
    targets: Sequence[int],
) -> list[Optional[tuple[int, int]]]:
    """
    First and last frame of each group of targets, inclusive.

    ``groups`` holds *positions* into the target sequence — one group per word —
    so a word's span is the span of its first and last label. ``None`` means the
    group was empty (a word with nothing alignable in it), which the caller
    interpolates rather than inventing a span for.
    """
    if len(repeats) != len(targets):
        raise AlignmentError(
            f"the path visits {len(repeats)} label(s) but {len(targets)} were asked for; "
            "the alignment cannot be trusted"
        )
    out: list[Optional[tuple[int, int]]] = []
    for group in groups:
        if not group:
            out.append(None)
            continue
        first, last = group[0], group[-1]
        if first >= len(repeats) or last >= len(repeats):
            out.append(None)
            continue
        out.append((repeats[first][1], repeats[last][2]))
    return out


__all__ = [
    "AlignmentError",
    "MAX_CELLS",
    "NEG_INF",
    "Repeat",
    "forced_align",
    "group_spans",
    "log_softmax",
    "merge_repeats",
    "predecessors",
    "token_at",
]
