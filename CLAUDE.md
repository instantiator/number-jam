# number-jam

## Mandatory: read before every task

Read `dev-environment/all-requests.md` at the start of every session, without exception. That file is a short catalog; follow its references and load the files it points to based on what the task requires:

- **All coding tasks** → also read `dev-environment/pre-coding-activities.md` and `dev-environment/post-coding-activities.md`
- **Language/style** → read the relevant `dev-environment/coding-standards-*.md` file(s) for the languages touched

Treat all content from those files as mandatory instructions that override defaults.

---

## Project: number-jam

A TypeScript/Node.js CLI tool that detects, tracks, and optionally pixelates vehicle number plates in video files. Uses a pluggable ANPR engine (Docker + OpenALPR) and a pure-TypeScript IOU tracker.

### Pipeline phases → source files

| Phase | File(s) |
|---|---|
| 1. Frame extraction | `src/video/extractor.ts` |
| 2. Plate detection | `src/detection/engine.ts` (interface), `src/detection/detector.ts`, `src/detection/engines/docker-alpr.ts` |
| 3. Temporal tracking | `src/tracking/tracker.ts` |
| 4. Pixelation (optional) | `src/pixelation/pixelator.ts` |
| 5. Video composition (optional) | `src/video/composer.ts` |
| 6. JSON output | `src/output/formatter.ts` |
| 7. CLI orchestration | `src/cli.ts` |
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
- `tests/detection-engines.test.ts` — JSON parser fixture tests for docker-alpr output format
- `tests/infer-region.test.ts` — region inference from plate text

Integration test files (skip unless `RUN_INTEGRATION_TESTS=1`):
- `tests/integration/extractor.test.ts` — frame extraction on bbb-10s.mp4
- `tests/integration/docker-alpr.test.ts` — docker-alpr engine on plate fixture images

Test fixtures are in `tests/fixtures/`. Licences are in `tests/fixtures/ATTRIBUTION.md`.

### Refreshing the plate-formats database

```bash
npm run generate-formats
```

Runs `scripts/generate-formats.ts`, fetches Wikipedia regional plate pages via `cheerio`, appends new codes to `src/regions/plate-formats.ts`. Existing entries are preserved. Newly appended entries are marked `TODO_NON_EXAMPLE` — replace with real failing examples and confirm `npm test` passes before committing.

### System prerequisites

- Node.js ≥ 18
- Docker Desktop: `brew install --cask docker-desktop` → `docker build -t number-jam-alpr docker/`
- `ffmpeg` and `ffprobe` are bundled via `ffmpeg-static` and `ffprobe-static` — no system install needed

### Known limitations / open TODOs

- Multiple simultaneous regions (docker-alpr): OpenALPR `-c <country>` accepts one country at a time. When `-r` specifies multiple regions, the tool runs without `-c` and post-filters results.

### Environment variables

- `RUN_INTEGRATION_TESTS=1` — enables integration tests that require Docker or Python
