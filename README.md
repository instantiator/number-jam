# number-jam

Detect, track, and optionally pixelate vehicle number plates in video files.

number-jam scans every frame of a video using an ANPR engine, links detections across frames into continuous tracks (including partial/unreadable plates), and emits a structured JSON document. When given `--pixelate-number-plates`, it also produces a new video file with the plate regions blurred.

---

## Prerequisites

| Dependency | Version | Install |
|---|---|---|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| Docker Desktop | any | see below |

`ffmpeg` and `ffprobe` are **bundled** via npm packages — you do not need to install them separately.

### Install the default ANPR engine (Docker + OpenALPR)

**macOS:**
```bash
./scripts/install-mac.sh
# or manually:
brew install --cask docker-desktop
docker build -t number-jam-alpr docker/
```

**Linux (Ubuntu/Debian):**
```bash
./scripts/install-linux.sh
# or manually:
sudo apt-get install docker.io && sudo systemctl start docker
docker build -t number-jam-alpr docker/
```

### Install the alternative ANPR engine (fast-alpr, Python)

```bash
pip3 install fast-alpr
```

---

## Installation

```bash
npm install
npm run build
```

---

## Usage

```bash
# Basic detection — print JSON to stdout
./run-mac.sh -i path/to/video.mp4

# Filter by region (comma-separated ISO codes)
./run-mac.sh -i video.mp4 -r gb,de,fr

# Detect and pixelate plates in an output video
./run-mac.sh -i video.mp4 -o output.mp4 --pixelate-number-plates

# Use the fast-alpr engine instead of Docker
./run-mac.sh --engine fast-alpr -i video.mp4

# Pipe JSON output to a file
./run-mac.sh -i video.mp4 > results.json
```

On Linux, replace `./run-mac.sh` with `./run-linux.sh`.

### Options

| Flag | Description |
|---|---|
| `-i`, `--input <path>` | Path to the input video file **(required)** |
| `-o`, `--output <path>` | Path for the pixelated output video *(required with `-p`)* |
| `-p`, `--pixelate-number-plates` | Pixelate detected plates in an output video |
| `-r`, `--regions <codes>` | Comma-separated region codes (e.g. `gb,de,us`). Defaults to all. |
| `--engine <id>` | ANPR backend: `docker-alpr` *(default)* or `fast-alpr` |

### Region codes

Region codes follow ISO 3166-1 alpha-2 (e.g. `gb`, `de`, `fr`, `us`, `au`). Run `npm test` to see the full list — every entry in `src/regions/plate-formats.ts` is exercised by the test suite.

---

## Output format

The tool prints a single JSON document to stdout:

```jsonc
{
  "request": {
    "path": "video.mp4",       // input path as given
    "regions": ["gb", "de"],   // region filter ("*" = all)
    "pixelate": false
  },
  "summary": [
    { "plate": "AB12CDE", "region": "gb" },
    { "plate": "",         "region": null }  // unreadable partial plate
  ],
  "tracking": [
    {
      "plate": "AB12CDE",
      "history": [
        {
          "timestamp": 1.04,                // seconds from video start
          "polygon": [[100,200],[200,200],[200,250],[100,250]]
        }
        // ... one entry per frame the plate was visible
        // gaps between actual detections are interpolated
      ]
    }
  ]
}
```

Progress information (frame count, detection counts, etc.) is written to **stderr** so that stdout can be cleanly piped to `jq` or a file.

---

## Running tests

```bash
# Unit tests (no Docker or Python required)
npm test

# Unit tests with coverage report
npm run test:coverage

# Integration tests (requires Docker + fixtures)
npm run download-fixtures
npm run test:integration
```

Unit test files:
- **plate-formats.test.ts** — every regex in the plate-formats database is exercised with at least one passing and one failing example
- **tracker.test.ts** — IOU tracker logic (assignment, gap-filling, track closure)
- **detection-engines.test.ts** — JSON parser fixtures for docker-alpr and fast-alpr output formats
- **infer-region.test.ts** — region inference utility (plate text → ISO region code)

Integration tests (`tests/integration/`) require `RUN_INTEGRATION_TESTS=1` and use public-domain video and image fixtures. See `tests/fixtures/ATTRIBUTION.md` for licence details.

---

## Project structure

```
number-jam/
├── src/
│   ├── cli.ts                         Entry point; orchestrates the full pipeline
│   ├── types.ts                       Shared TypeScript interfaces
│   ├── video/
│   │   ├── extractor.ts               Extract frames from video via ffmpeg
│   │   └── composer.ts                Re-encode frames into output video
│   ├── detection/
│   │   ├── engine.ts                  DetectionEngine interface
│   │   ├── detector.ts                Iterate frames and collect detections
│   │   └── engines/
│   │       ├── docker-alpr.ts         Docker + OpenALPR HTTP backend
│   │       └── fast-alpr.ts           Python fast-alpr stdio daemon backend
│   ├── tracking/
│   │   └── tracker.ts                 IOU-based multi-frame tracker with gap interpolation
│   ├── pixelation/
│   │   └── pixelator.ts               Block-pixelate plate regions using sharp
│   ├── regions/
│   │   ├── plate-formats.ts           International plate format regex database
│   │   └── infer-region.ts            Infer region from plate text (used by fast-alpr engine)
│   └── output/
│       └── formatter.ts               Build the final JSON output document
├── docker/
│   ├── Dockerfile                     Builds the number-jam-alpr image
│   └── alpr-server.py                 Flask HTTP wrapper around the openalpr CLI
├── scripts/
│   ├── install-mac.sh                 macOS prerequisite installer
│   ├── install-linux.sh               Linux prerequisite installer
│   ├── detect-frame.py                fast-alpr Python stdio daemon
│   ├── download-fixtures.ts           Downloads test fixture files (idempotent)
│   └── generate-formats.ts            Wikipedia scraper (refreshes plate-formats.ts)
├── tests/
│   ├── plate-formats.test.ts
│   ├── tracker.test.ts
│   ├── detection-engines.test.ts
│   ├── infer-region.test.ts
│   ├── fixtures/
│   │   └── ATTRIBUTION.md             Licence information for test fixtures
│   └── integration/
│       ├── extractor.test.ts
│       ├── docker-alpr.test.ts
│       └── fast-alpr.test.ts
├── run-mac.sh                         Launch script for macOS
└── run-linux.sh                       Launch script for Linux
```

---

## Regenerating the plate-formats database

```bash
npm run generate-formats
```

This fetches several Wikipedia regional vehicle registration plate pages (Europe, Americas, Asia, Oceania, Africa) and appends any new region codes to `src/regions/plate-formats.ts`. Existing hand-curated entries are preserved. The generated file is checked in.

> **Note:** newly appended entries are marked `TODO_NON_EXAMPLE` in their `nonExamples` field. Replace these with real failing examples and ensure `npm test` passes before committing.
