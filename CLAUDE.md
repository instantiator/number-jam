# number-jam

## Mandatory: read before every task

Read `dev-environment/all-requests.md` at the start of every session, without exception. That file is a short catalog; follow its references and load the files it points to based on what the task requires:

- **All coding tasks** → also read `dev-environment/pre-coding-activities.md` and `dev-environment/post-coding-activities.md`
- **Language/style** → read the relevant `dev-environment/coding-standards-*.md` file(s) for the languages touched

Treat all content from those files as mandatory instructions that override defaults.

---

## Project: number-jam

A TypeScript/Node.js CLI tool that detects, tracks, and optionally obscures vehicle number plates in video files. Uses a pluggable ANPR engine (Docker + OpenALPR), a pure-TypeScript IOU tracker, and SAD template matching for entry/exit tracking.

### Pipeline phases → source files

| Phase | File(s) |
|---|---|
| 1. Frame extraction | `src/video/extractor.ts` |
| 2. Plate detection | `src/detection/engine.ts` (interface), `src/detection/detector.ts`, `src/detection/engines/docker-alpr.ts` |
| 2b. Character scan (optional, obscuring only) | `src/cli/character-scan.ts` |
| 3. Temporal tracking | `src/tracking/tracker.ts` |
| 3b. Motion helpers | `src/tracking/motion.ts` |
| 3c. Visual tracking (entry/exit) | `src/tracking/visual-tracker.ts` |
| 4. Obscuring (optional) | `src/obscuring/obscurer.ts` |
| 5. Video composition (optional) | `src/video/composer.ts` |
| 6. JSON output | `src/output/formatter.ts` |
| 7. CLI entry point | `src/cli.ts` |
| 7a. CLI phase functions | `src/cli/phases.ts` |
| 7b. CLI progress bars | `src/cli/progress.ts` |
| Shared types | `src/types.ts` |
| Plate format DB | `src/regions/plate-formats.ts` |
| Region inference | `src/regions/infer-region.ts` |

### Engine architecture

The `DetectionEngine` interface in `src/detection/engine.ts` has four methods:

- `check()` — verify prerequisites (Docker present + running)
- `startup()` — start the background service (Docker container) once before the frame loop
- `detectPlates(framePath, frameIndex, regions)` — called once per frame
- `shutdown()` — stop and clean up; called in `finally`; must not throw

**docker-alpr** (`src/detection/engines/docker-alpr.ts`):
- Starts a `number-jam-alpr` container on a random free port
- POSTs JPEG bytes to its Flask HTTP endpoint (`/detect?region=<code>`)
- Parses the standard OpenALPR JSON format (see schema below)
- Container name: `number-jam-alpr-<pid>`

### OpenALPR JSON output schema (docker-alpr)

```json
{
  "version": 2,
  "data_type": "alpr_results",
  "results": [
    {
      "plate": "AB12CDE",
      "confidence": 89.5,
      "region": "gb",
      "region_confidence": 75.0,
      "coordinates": [
        { "x": 100, "y": 200 },
        { "x": 200, "y": 200 },
        { "x": 200, "y": 250 },
        { "x": 100, "y": 250 }
      ]
    }
  ]
}
```

### Running tests

```bash
npm test                      # all unit tests (vitest)
npm run typecheck             # type-check src + tests (no emit)
npm run build                 # compile src → dist
npm run test:coverage         # unit tests with coverage report (@vitest/coverage-v8)

npm run download-fixtures     # download test fixture files (idempotent)
npm run test:integration      # integration tests (requires RUN_INTEGRATION_TESTS=1 + fixtures)
```

Unit test files:
- `tests/plate-formats.test.ts` — every regex in PLATE_FORMATS gets a positive + negative case
- `tests/tracker.test.ts` — IOU tracker unit tests (synthetic frame data)
- `tests/motion.test.ts` — centroid, velocity, and polygon-shift helpers
- `tests/phases.test.ts` — `velocityFromBackCoverage` helper unit tests
- `tests/detection-engines.test.ts` — JSON parser fixture tests for docker-alpr output format
- `tests/infer-region.test.ts` — region inference from plate text
- `tests/obscurer.test.ts` — plate obscuring geometry helpers and end-to-end
- `tests/polygon-merge.test.ts` — `mergeOverlappingPolygons` union-find unit tests
- `tests/visual-tracker.test.ts` — SAD template-matching tracker on synthetic JPEG frames
- `tests/character-scan.test.ts` — tesseract character scan on synthetic JPEG frames
- `tests/formatter.test.ts` — JSON output document builder
- `tests/cli.test.ts` — `parseRegions` and `warnUnknownRegions` helpers

Integration test files (skip unless `RUN_INTEGRATION_TESTS=1`):
- `tests/integration/extractor.test.ts` — frame extraction on bbb-10s.mp4
- `tests/integration/docker-alpr.test.ts` — docker-alpr engine on plate fixture images

Test fixtures are in `tests/fixtures/`. Licences are in `tests/fixtures/ATTRIBUTION.md`.

### Refreshing the plate-formats database

```bash
npm run generate-formats
```

Runs `scripts/generate-formats.ts`, fetches Wikipedia regional plate pages via `cheerio`, appends new codes to `src/regions/plate-formats.ts`. Existing entries are preserved. Newly appended entries are marked `TODO_NON_EXAMPLE` — replace with real failing examples and confirm `npm test` passes before committing.

### Character scan (phase 2b, obscuring only)

`runCharacterScan` (`src/cli/character-scan.ts`) runs after ANPR detection and before track building when `--obscure-number-plates` is active. For each detection frame it:

1. Expands the ANPR polygon horizontally by 50 % of the plate width on each side.
2. Crops that expanded region and runs tesseract.js OCR on it.
3. Any alphanumeric character found outside the ANPR polygon (with confidence > 40) causes the polygon to be widened to cover it.

This corrects the common case where OpenALPR clips the first one or two characters (e.g. "HF" from "HF6CZB"). The widened polygon is then used as the template for SAD visual tracking, so all backward and forward coverage frames inherit the corrected width.

### Visual tracking (entry/exit)

Phase 3b extends each detected track using three layers in priority order:

1. **SAD template matching** (`visual-tracker.ts`, pure TypeScript + sharp) — extracts a downsampled greyscale plate template from the endpoint frame, then slides it over a search window (last-known bbox ± 40 px) in each preceding/following frame using Sum of Absolute Differences. Tracking is **unconstrained in time** — it continues until match score exceeds an adaptive threshold or the polygon fully leaves the frame. The threshold relaxes proportionally as the plate moves off-screen, allowing partial-plate tracking as vehicles enter or exit. The template refreshes every 5 frames to adapt to lighting and angle changes. No WASM or native dependencies.
2. **Velocity extrapolation** (`motion.ts`) — applied at the outermost boundary beyond where visual tracking stops (not as an alternative to it). Extrapolates for `--extend-seconds` seconds further.
3. **Gap-filling** (`trackGap` in `visual-tracker.ts`) — fills intra-track frame gaps with visual tracking before falling back to the existing linear interpolation.

`--extend-seconds` controls only the velocity-extrapolation layer; visual tracking itself runs as long as confidence holds.

### System prerequisites

- Node.js ≥ 18
- Docker Desktop: `brew install --cask docker-desktop` — the `number-jam-alpr` image is built automatically on first run via `DockerAlprEngine.ensureImage()` in `src/detection/engines/docker-alpr.ts`
- `ffmpeg` and `ffprobe` are bundled via `ffmpeg-static` and `ffprobe-static` — no system install needed

### Known limitations / open TODOs

- Multiple simultaneous regions (docker-alpr): OpenALPR `-c <country>` accepts one country at a time. When `-r` specifies multiple regions, the tool runs without `-c` and post-filters results.

### CLI options (obscuring)

| Flag | Default | Description |
|---|---|---|
| `-o`, `--obscured-output <path>` | — | Write obscured video to this path |
| `-x`, `--extend-detection <ms>` | 2000 | Velocity-extrapolate polygons this many ms past visual tracking |
| `-m`, `--min-fraction <n>` | 0.01 | Minimum visible plate fraction to include a frame |
| `-f`, `--fade-duration <ms>` | 1000 | Fade polygons in/out over this many ms at appearance/disappearance |
| `--padding-width <amount>` | — | Expand each polygon left/right by this amount per side (e.g. `10`, `10px`, `5%`) |
| `--padding-height <amount>` | — | Expand each polygon top/bottom by this amount per side |
| `--rebuild-docker-image` | — | Force a rebuild of the `number-jam-alpr` image even if it already exists |

### Fade implementation

`computeFadeExtensions` (`src/cli/phases.ts`) runs after `runTrackCoverage`. It finds contiguous runs in `trackPolygons` and adds:
- **Fade-in frames** before each run using the run's first polygon, with alpha ramping 0 → 1.
- **Fade-out frames** after each run using the run's last polygon, with alpha ramping 1 → 0.

If the fade window would extend past the video start or end, the window is clipped but the alpha rate is unchanged (partial fade). The resulting `fadeAlphas: Map<number, number>` is passed to `runObscuring` and applied per-frame in `buildPolygonOverlay` by scaling the blurred mask buffer.

### Padding implementation

`expandPolygon` (`src/obscuring/obscurer.ts`) converts the ANPR polygon to an axis-aligned rectangle expanded by the padding amount on each side, keeping the polygon centred on its original centre point. `%` values are a percentage of the polygon's own width or height (each side). The expanded polygon is used for both colour sampling and the SVG alpha mask.

### Environment variables

- `RUN_INTEGRATION_TESTS=1` — enables integration tests that require Docker or Python
