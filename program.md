# UMB Campus 3D — Autoresearch Program

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch), this file steers iterative hill-climbing on **UMB Campus 3D** against a fixed, deterministic local evaluation (`npm run eval`).

## Goal

Maximize `SCORE` (0–100) while preserving strict client-side privacy and prioritizing the real-campus look and feel of **UMass Boston (Columbia Point, Boston MA)**:
1. **Real-campus feel:** authentic materials & lighting, accurate building massing/heights from cited public sources, Boston Harbor / Dorchester Bay / Savin Hill Cove coastline and water from OSM, realistic ground/plazas/green spaces/walkways.
2. **Phone-first 3D performance:** high median and p5 FPS on `390x844` under 4x CPU throttle (merged static geometry, shared materials, render-on-demand when idle, minimal DOM churn).
3. **Lean PWA & accessibility:** smaller initial JS gzip bundle (lazy-load non-critical parsers), high Lighthouse mobile Performance & Accessibility, rock-solid offline installability.
4. **Correctness & privacy:** accurate UMB schedule parsing (ICS/PDF/text, online classes never routed) and obstacle-free walking routes.

## Scope — Editable vs Immutable Files

### May Change (Experiment Surface)
- `src/**` (application code, 3D scene, shaders/materials, routing, parser, CSS)
- `public/**` (static assets, `public/data/umb-campus.geojson`, `public/sw.js`, `public/manifest.webmanifest`)
- `index.html`, `vite.config.ts`, `package.json` (only if needed for app optimization; never to weaken gates)
- `scripts/**` (data-processing scripts such as `scripts/fetch-osm.mjs`)

### Must NOT Change (Immutable Eval & Reference Ground Truth)
- `eval/run-eval.mjs`
- `eval/fixtures/**`
- `eval/reference/**` (cited BPDA/OSM height table, OSM coastline, Wikimedia Commons photos & attribution)
- Hard gates in `eval/run-eval.mjs`
- `program.md` weights/rules during a hill-climbing run

Never edit the eval, fixtures, reference data, or hard gates to raise the score.

## Scoring Weights & Hard Gates

### Hard Gates (if ANY fails, `SCORE = 0`)
1. `npm run typecheck` passes cleanly.
2. `npm run build` succeeds.
3. `npm test` (Vitest unit tests) passes cleanly.
4. **No-schedule-data network & storage audit:** load the built app in headless Chromium, upload fixture `.ics`, fixture `.pdf`, and pasted text containing sentinel strings (including Spring 2027 `CS 285L`, `MUSIC 111`, `MATH 345`, `SOCIOL 101` online), and verify:
   - Zero requests to any non-same-origin URL.
   - Zero schedule/sentinel text in `localStorage`, `sessionStorage`, `IndexedDB`, `Cache Storage`, request URLs, or request bodies.
   - Online class (`SOCIOL 101`) is marked unmapped and produces no route.

### Weighted Metrics (Sum = 100)

| Metric | Weight | Measurement |
| --- | ---: | --- |
| `parser` | **20** | Accuracy on 36 fixed UMB schedule cases + 5 ICS fixture checks (41 checks total; exact `buildingId` + `room` match, online classes unmapped). |
| `routing` | **20** | 18 fixed `(startPoint, building)` pairs: reaches building exterior within 45 m (40%), length within `[0.85x, 1.35x]` of an independent outdoor Dijkstra shortest path (30%), zero building-footprint or OSM coastline water crossings (30%). |
| `phoneFps` | **20** | Headless Chromium at `390x844` (2x DPR) with 4x CPU throttle during a scripted 10 s route animation: `0.60 * min(100, medianFps / 60 * 100) + 0.40 * min(100, p5Fps / 45 * 100)`. |
| `lighthousePwa` | **15** | Mobile Lighthouse Performance (40%) + Mobile Lighthouse Accessibility (35%) + direct installability checks (25%: valid manifest, 192/512/maskable icons, theme-color, active SW with build-hashed cache, visit-1 offline reload). |
| `bundleGzip` | **10** | Total gzip KB of initial JS chunks referenced by `dist/index.html`: `100` at ≤120 KB, `0` at ≥300 KB, linear between. |
| `realism` | **15** | 60% building height accuracy across 79 cited buildings (`eval/reference/building-heights.json`, sourced from BPDA 2010 LiDAR `Boston_Buildings` FeatureServer Layer 9 and OSM `building:levels`; post-2010 buildings with BPDA placeholder values like ISC and University Hall are excluded) + 40% Sobel edge/silhouette windowed SSIM against 3 openly licensed Wikimedia Commons UMass Boston photos (`eval/reference/photos/ATTRIBUTION.md`) at fixed camera spots. |

## Autoresearch Loop Rules

1. Make **one focused change** per experiment.
2. Run `npm run eval`.
3. **Keep / Revert rule:**
   - If all hard gates pass AND `SCORE` improves by **at least +0.50** over the current best kept score: `git commit` with the new score in the commit message.
   - Otherwise: revert all code changes (`git checkout -- .` / clean untracked experiment files) so the working tree returns cleanly to the best kept commit.
4. Append every experiment (kept or reverted) as one tab-separated row to `results.tsv`.
5. **Stopping budget:** stop after **120 minutes wall clock**, **25 experiments**, or **6 consecutive non-improving experiments**, whichever comes first.

## Log Format (`results.tsv`)

Tab-separated columns:
```
experiment	commit	score	delta	parser	routing	phoneFps	lighthousePwa	bundleGzip	realism	status	idea
```
- `experiment`: `baseline`, `exp-01`, `exp-02`, …
- `commit`: 7-char git SHA (kept commit SHA, or current HEAD SHA if reverted)
- `score`: scalar `SCORE` to 2 decimals
- `delta`: change vs previous best kept score (e.g. `+2.35`, `-0.12`)
- `parser`..`realism`: per-metric 0–100 subscores
- `status`: `baseline`, `kept`, or `reverted`
- `idea`: concise one-line description of the experiment
