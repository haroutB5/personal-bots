# Eco mode comparison, 27 Nov 2026

Twelve runs on a throwaway hbots server (release `75415bd7be83`, Eco v1 before the
pre-ship fixes), the Developer bot on real Claude Opus 5.5 (effort high). Eco OFF runs
the whole task on Opus; Eco ON plans on Opus and hands off to Sonnet 5.5 through
`eco_handoff`. Three tasks on npm's `semver` 7.6.3, two repetitions each:

- **T1**: add `semver.truncate()` and a `-t/--truncate <level>` CLI flag.
- **T2**: make `SemVer`, `Range` and `Comparator` serialise to JSON and round-trip
  (existing modules only).
- **T3**: add `semver.inspect()` and a `--json` CLI flag that "must work together with
  `-r`, `-i`, `-c` and `--rv`". A prompt trap: the CLI accepts `-rv`, `-rev`, `--rev` and
  `--reverse`, but not `--rv`, which it silently ignores. The hidden acceptance runs
  `--json --rv 2.0.0 1.0.0` and expects reversed order, so passing needs noticing that.

"ok" needs both the hidden acceptance script and `npx tap` (100% coverage) to pass.
Cost is list price from each run's Claude transcripts, priced message by message with
5-minute and 1-hour cache writes at their own rates (LiteLLM rates; all cache writes in
these runs were 1-hour). Per-run data, without local paths: `comparison-2026-11-27.jsonl`.

| run      | ok (accept/tap) | files   | wall s | handoff | planner $ (calls) | builder $ (calls) | cache read $ | cache write $ | total $ |
| -------- | --------------- | ------- | ------ | ------- | ----------------- | ----------------- | ------------ | ------------- | ------- |
| T1-off-1 | ✓ (✓/✓)         | 5+2 new | 140    | –       | 0.657 (15)        | 0.000 (0)         | 0.148        | 0.335         | 0.657   |
| T1-on-1  | ✓ (✓/✓)         | 5+2 new | 103    | yes     | 0.457 (4)         | 0.299 (7)         | 0.054        | 0.574         | 0.756   |
| T2-off-1 | ✓ (✓/✓)         | 7+0 new | 155    | –       | 0.595 (16)        | 0.000 (0)         | 0.158        | 0.241         | 0.595   |
| T2-on-1  | ✓ (✓/✓)         | 7+0 new | 86     | yes     | 0.188 (4)         | 0.149 (6)         | 0.053        | 0.172         | 0.337   |
| T3-off-1 | ✓ (✓/✓)         | 5+2 new | 121    | –       | 0.533 (12)        | 0.000 (0)         | 0.116        | 0.256         | 0.533   |
| T3-on-1  | ✗ (✗/✓)         | 5+2 new | 87     | yes     | 0.220 (3)         | 0.190 (7)         | 0.055        | 0.249         | 0.410   |
| T1-off-2 | ✓ (✓/✓)         | 5+2 new | 144    | –       | 0.553 (15)        | 0.000 (0)         | 0.146        | 0.242         | 0.553   |
| T1-on-2  | ✓ (✓/✓)         | 5+2 new | 108    | yes     | 0.239 (4)         | 0.217 (8)         | 0.068        | 0.249         | 0.456   |
| T2-off-2 | ✓ (✓/✓)         | 7+0 new | 117    | –       | 0.493 (12)        | 0.000 (0)         | 0.107        | 0.216         | 0.493   |
| T2-on-2  | ✓ (✓/✓)         | 7+0 new | 87     | yes     | 0.166 (3)         | 0.156 (7)         | 0.050        | 0.168         | 0.321   |
| T3-off-2 | ✗ (✗/✓)         | 5+2 new | 159    | –       | 0.600 (16)        | 0.000 (0)         | 0.159        | 0.260         | 0.600   |
| T3-on-2  | ✗ (✗/✓)         | 5+2 new | 90     | yes     | 0.229 (4)         | 0.171 (6)         | 0.056        | 0.221         | 0.399   |

| task | OFF avg $ | ON avg $ | Δ cost | OFF success | ON success | OFF wall | ON wall |
| ---- | --------- | -------- | ------ | ----------- | ---------- | -------- | ------- |
| T1   | 0.605     | 0.606    | 0%     | 2/2         | 2/2        | 142      | 106     |
| T2   | 0.544     | 0.329    | -40%   | 2/2         | 2/2        | 136      | 87      |
| T3   | 0.566     | 0.405    | -29%   | 1/2         | 0/2        | 140      | 89      |
| all  | 0.572     | 0.447    | -22%   | 5/6         | 4/6        | 139      | 94      |

## Findings

- Eco ON was **22% cheaper** ($0.447 vs $0.572 a run) and about a third faster
  (94 s vs 139 s), with the planner making 3-4 calls before handing off.
- Success was 4/6 ON vs 5/6 OFF. **Every failure was T3's `--rv` trap** (output `1.0.0, 2.0.0`,
  not reversed): the Eco planner assumed `--rv` already worked and wrote it into the plan,
  and Sonnet followed the plan as written. One OFF run fell into the same trap.
- The Eco record (`personal_eco_turns`) understated cost by about 25-30% against the
  transcript (T1-on-1: $0.540 recorded vs $0.756), because it priced the SDK's summed
  `modelUsage`, which merges 1-hour cache writes into the 5-minute count.

## Fixes made after this comparison (branch `eco-mode`)

- The recorder prices each API call from its own usage, 1-hour writes at the 1-hour rate.
- The planner must confirm every file, function, option and flag its plan names, and list
  what it could not confirm under Risks.
- The builder does what the task asks when the code contradicts the plan, and says so.
