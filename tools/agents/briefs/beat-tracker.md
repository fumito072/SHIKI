# Task: BeatTracker — tempo and beat phase from onset strength

You are Codex working in the SHIKI repository. Read `AGENTS.md` first.

## Files you own (create/modify only these)

- `src/audio/BeatTracker.ts` — replace the placeholder implementation
- `src/audio/BeatTracker.test.ts` — new

Do not change `src/audio/beat.ts` (the interface) or any other file.

## Context

`src/audio/beat.ts` defines `BeatTrackerLike`. The audio analyzer calls `push(onsetStrength, timeMs)` about 60 times
per second with a spectral-flux onset strength (non-negative, unnormalized, noisy; frame timing jitters by a few ms).
The clock calls `estimate()` every frame; when `confidence >= 0.4` it phase-locks to `(bpm, beatTimeMs)`.
Typical inputs: club music (steady kick on every beat, hats on 8ths/16ths) and live bands (drifting tempo ±3 BPM).

## Requirements

- Export `class BeatTracker implements BeatTrackerLike` with an optional constructor options object
  (`minBpm = 80`, `maxBpm = 170`, history length, …).
- Resample the irregular input onto a fixed grid (e.g. 10 ms bins) and keep ~8 s of history in a ring buffer.
- Tempo: autocorrelation or comb-filter bank over the onset envelope, refined to sub-bin precision.
  Resolve octave ambiguity with a mild preference for tempi near 120 BPM, but clear evidence must win
  (96 and 142 BPM must be reported as such, not doubled or halved).
- Phase: pick the beat offset that best aligns predicted beat times with onset peaks; `beatTimeMs` is the most
  recent predicted beat at or before the latest pushed time.
- Stability: smooth the estimate (no flapping between candidates), yet follow a tempo change within ~4 s.
- `confidence` in 0..1 from peak prominence and consistency over time. Silence or noise → below 0.2 (or `null`).
- Cost: the heavy recompute at most ~10 times per second; `push` must not allocate.
- No dependencies.

## Tests (vitest, synthetic signals)

- Click trains at 96, 128 and 142 BPM with ±10 ms jitter and a noise floor → BPM within ±1.0 after 8 s,
  phase error < 25 ms.
- Kicks on beats plus hats on 8ths at 128 BPM → 128 (not 64 or 256).
- Tempo change 120 → 132 at 10 s → within ±1.0 BPM by 14 s.
- Pure noise and silence → confidence < 0.2 or `null`.

## Done when

- `npx vitest run src/audio` passes.
- `npx tsc --noEmit` reports no errors in your two files (other files may be under construction by another agent;
  report but ignore errors outside your files).

Final message: a short summary of the algorithm, the test results, and known limitations.
