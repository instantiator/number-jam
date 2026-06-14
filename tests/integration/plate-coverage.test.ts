/**
 * Integration tests for plate-coverage quality on user-supplied video fixtures.
 *
 * For each `.mp4` found in `tests/fixtures/videos/` that has a matching
 * `<filename>.metadata.json`, the full detection/tracking/obscuring pipeline
 * is executed once (in `beforeAll`) and the results are shared across all
 * per-plate `it` tests within that video's `describe` block.
 *
 * Skipped entirely unless `RUN_INTEGRATION_TESTS=1` is set.
 * Add videos to `tests/fixtures/videos/` — they are git-ignored by design.
 *
 * @see {@link TestVideoMetadata} for the metadata file format.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCharacterScan } from "../../src/cli/character-scan";
import {
  runDetection,
  runExtraction,
  runObscuring,
  runPreProcessing,
  runTrackBuilding,
  runTrackCoverage,
} from "../../src/cli/phases";
import { DockerAlprEngine } from "../../src/detection/engines/docker-alpr";
import { FrameInfo, FrameResult, Point, Track } from "../../src/types";
import { VideoInfo } from "../../src/video/extractor";
import { TestVideoMetadata } from "./types";

const VIDEOS_DIR = path.resolve(process.cwd(), "tests/fixtures/videos");
const SKIP_INTEGRATION = !process.env["RUN_INTEGRATION_TESTS"];

/** Discover video fixtures synchronously at module load time. */
const videoFixtures: Array<{ videoPath: string; metadata: TestVideoMetadata }> =
  fs
    .readdirSync(VIDEOS_DIR)
    .filter((f) => f.endsWith(".mp4"))
    .flatMap((f) => {
      const videoPath = path.join(VIDEOS_DIR, f);
      const metaPath = videoPath.replace(/\.mp4$/, ".metadata.json");
      if (!fs.existsSync(metaPath)) return [];
      const metadata: TestVideoMetadata = JSON.parse(
        fs.readFileSync(metaPath, "utf8"),
      );
      return [{ videoPath, metadata }];
    });

// Module-level pure helpers

/**
 * Edit distance between two strings (standard Levenshtein, O(m·n) space O(m)).
 * Used to tolerate single-character ANPR misreads.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  // dp[i] = edit distance between a[0..i] and b[0..current j]
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const temp = dp[i];
      dp[i] =
        a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = temp;
    }
  }
  return dp[m];
}

/**
 * Returns all non-empty {@link Track}s whose plate text closely matches `plate`.
 * Tries exact case-insensitive match first; falls back to Levenshtein distance ≤ 2
 * to tolerate common ANPR misreads (e.g. a dropped or transposed character).
 */
function matchingTracks(plate: string, tracks: Track[]): Track[] {
  const upper = plate.toUpperCase();
  const exact = tracks.filter((t) => t.plate.toUpperCase() === upper);
  if (exact.length > 0) return exact;
  return tracks.filter(
    (t) => t.plate.length > 0 && levenshtein(t.plate.toUpperCase(), upper) <= 2,
  );
}

/**
 * Returns the frame-index window `[startFi, endFi]` during which `plate` is
 * expected to be visible.  Uses metadata seconds when provided, otherwise falls
 * back to the min/max history frame indices across all matching tracks.
 */
function plateFrameWindow(
  plate: string,
  tracks: Track[],
  fps: number,
  visibleFrom?: number,
  visibleUntil?: number,
): { startFi: number; endFi: number } {
  const pt = matchingTracks(plate, tracks);
  const allFis = pt.flatMap((t) => t.history.map((h) => h.frameIndex));
  return {
    startFi:
      visibleFrom !== undefined
        ? Math.round(visibleFrom * fps)
        : Math.min(...allFis),
    endFi:
      visibleUntil !== undefined
        ? Math.round(visibleUntil * fps)
        : Math.max(...allFis),
  };
}

/** Returns covered frame indices within `[startFi, endFi]`, sorted ascending. */
function coveredFramesInWindow(
  startFi: number,
  endFi: number,
  trackPolygons: Map<number, Point[][]>,
): number[] {
  return [...trackPolygons.keys()]
    .filter((fi) => fi >= startFi && fi <= endFi)
    .sort((a, b) => a - b);
}

/** Axis-aligned bounding-box area of a polygon. */
function bboxArea(polygon: Point[]): number {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  return (
    Math.max(0, Math.max(...xs) - Math.min(...xs)) *
    Math.max(0, Math.max(...ys) - Math.min(...ys))
  );
}

// Engine is shared across all video fixtures to avoid repeated Docker startups.
let engine: DockerAlprEngine;

describe("plate-coverage integration", () => {
  beforeAll(async () => {
    if (SKIP_INTEGRATION) return;
    engine = new DockerAlprEngine(0);
    await engine.check();
    await engine.startup();
  }, 180_000);

  afterAll(async () => {
    if (SKIP_INTEGRATION) return;
    await engine?.shutdown().catch(() => undefined);
  }, 30_000);

  for (const { videoPath, metadata } of videoFixtures) {
    const videoName = path.basename(videoPath);

    describe(`video: ${videoName}`, () => {
      let tmpDir!: string;
      let obscureDir!: string;
      let frames!: FrameInfo[];
      let videoInfo!: VideoInfo;
      let frameResults!: FrameResult[];
      let tracks!: Track[];
      let trackPolygons!: Map<number, Point[][]>;

      beforeAll(async () => {
        if (SKIP_INTEGRATION) return;

        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nj-coverage-test-"));
        obscureDir = path.join(tmpDir, "obscured");
        const framesDir = path.join(tmpDir, "frames");
        fs.mkdirSync(obscureDir);
        fs.mkdirSync(framesDir);

        const extracted = await runExtraction(videoPath, framesDir);
        frames = extracted.frames;
        videoInfo = extracted.videoInfo;

        await runPreProcessing(frames, videoInfo.width);
        const rawFrameResults = await runDetection(frames, ["gb"], engine);
        frameResults = await runCharacterScan(
          frames,
          rawFrameResults,
          videoInfo.width,
          videoInfo.height,
        );
        tracks = runTrackBuilding(frameResults, videoInfo.fps);

        const extendFrames = Math.round(videoInfo.fps * 12);
        trackPolygons = await runTrackCoverage(
          tracks,
          frames,
          extendFrames,
          videoInfo.width,
          videoInfo.height,
          videoInfo.fps,
        );

        await runObscuring(frames, trackPolygons, obscureDir);
      }, 1_200_000);

      afterAll(async () => {
        if (SKIP_INTEGRATION) return;
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      }, 30_000);

      for (const expectation of metadata.expectations) {
        const { plate, visibleFrom, visibleUntil, hasEntries, hasExits } =
          expectation;

        describe(`plate: ${plate}`, () => {
          it.skipIf(SKIP_INTEGRATION)(
            "covers the plate without flicker or gaps",
            () => {
              expect(
                matchingTracks(plate, tracks).length,
                `No track found for plate "${plate}" — check metadata plate text`,
              ).toBeGreaterThan(0);

              const { startFi, endFi } = plateFrameWindow(
                plate,
                tracks,
                videoInfo.fps,
                visibleFrom,
                visibleUntil,
              );
              const covered = coveredFramesInWindow(
                startFi,
                endFi,
                trackPolygons,
              );

              // Minimum coverage: at least 2 s worth of frames.
              expect(covered.length).toBeGreaterThanOrEqual(
                Math.round(videoInfo.fps * 2),
              );

              // No gap > 1 s between consecutive covered frames.
              const maxGap = Math.round(videoInfo.fps);
              for (let i = 1; i < covered.length; i++) {
                expect(covered[i] - covered[i - 1]).toBeLessThanOrEqual(maxGap);
              }

              // Anti-flicker: area change ≤ 60 % between adjacent covered frames.
              for (let i = 1; i < covered.length; i++) {
                const prev = covered[i - 1];
                const cur = covered[i];
                if (cur - prev !== 1) continue;
                const prevPolys = trackPolygons.get(prev)!;
                const curPolys = trackPolygons.get(cur)!;
                if (!prevPolys.length || !curPolys.length) continue;
                const prevArea = bboxArea(prevPolys[0]);
                const curArea = bboxArea(curPolys[0]);
                if (prevArea === 0 || curArea === 0) continue;
                expect(Math.abs(curArea - prevArea) / prevArea).toBeLessThan(
                  0.6,
                );
              }
            },
          );

          it.skipIf(SKIP_INTEGRATION || !hasEntries?.includes("top"))(
            "covers the plate during entry if it enters from the top of the frame",
            () => {
              const { startFi, endFi } = plateFrameWindow(
                plate,
                tracks,
                videoInfo.fps,
                visibleFrom,
                visibleUntil,
              );
              const covered = coveredFramesInWindow(
                startFi,
                endFi,
                trackPolygons,
              );
              const openingEnd = startFi + Math.round(videoInfo.fps);
              const reachesTop = covered
                .filter((fi) => fi <= openingEnd)
                .some((fi) => {
                  const polys = trackPolygons.get(fi);
                  return polys?.length
                    ? Math.min(...polys[0].map(([, y]) => y)) <= 5
                    : false;
                });
              expect(reachesTop).toBe(true);
            },
          );

          it.skipIf(SKIP_INTEGRATION || !hasEntries?.includes("bottom"))(
            "covers the plate during entry if it enters from the bottom of the frame",
            () => {
              const { startFi, endFi } = plateFrameWindow(
                plate,
                tracks,
                videoInfo.fps,
                visibleFrom,
                visibleUntil,
              );
              const covered = coveredFramesInWindow(
                startFi,
                endFi,
                trackPolygons,
              );
              const openingEnd = startFi + Math.round(videoInfo.fps);
              const reachesBottom = covered
                .filter((fi) => fi <= openingEnd)
                .some((fi) => {
                  const polys = trackPolygons.get(fi);
                  return polys?.length
                    ? Math.max(...polys[0].map(([, y]) => y)) >=
                        videoInfo.height - 5
                    : false;
                });
              expect(reachesBottom).toBe(true);
            },
          );

          it.skipIf(SKIP_INTEGRATION || !hasEntries?.includes("left"))(
            "covers the plate during entry if it enters from the left of the frame",
            () => {
              const { startFi, endFi } = plateFrameWindow(
                plate,
                tracks,
                videoInfo.fps,
                visibleFrom,
                visibleUntil,
              );
              const covered = coveredFramesInWindow(
                startFi,
                endFi,
                trackPolygons,
              );
              const openingEnd = startFi + Math.round(videoInfo.fps);
              const reachesLeft = covered
                .filter((fi) => fi <= openingEnd)
                .some((fi) => {
                  const polys = trackPolygons.get(fi);
                  return polys?.length
                    ? Math.min(...polys[0].map(([x]) => x)) <= 5
                    : false;
                });
              expect(reachesLeft).toBe(true);
            },
          );

          it.skipIf(SKIP_INTEGRATION || !hasEntries?.includes("right"))(
            "covers the plate during entry if it enters from the right of the frame",
            () => {
              const { startFi, endFi } = plateFrameWindow(
                plate,
                tracks,
                videoInfo.fps,
                visibleFrom,
                visibleUntil,
              );
              const covered = coveredFramesInWindow(
                startFi,
                endFi,
                trackPolygons,
              );
              const openingEnd = startFi + Math.round(videoInfo.fps);
              const reachesRight = covered
                .filter((fi) => fi <= openingEnd)
                .some((fi) => {
                  const polys = trackPolygons.get(fi);
                  return polys?.length
                    ? Math.max(...polys[0].map(([x]) => x)) >=
                        videoInfo.width - 5
                    : false;
                });
              expect(reachesRight).toBe(true);
            },
          );

          it.skipIf(SKIP_INTEGRATION || !hasExits?.includes("top"))(
            "covers the plate during exit if it exits from the top of the frame",
            () => {
              const { endFi: plateEndFi } = plateFrameWindow(
                plate,
                tracks,
                videoInfo.fps,
                visibleFrom,
                visibleUntil,
              );
              const covered = coveredFramesInWindow(
                0,
                plateEndFi,
                trackPolygons,
              );
              const closingStart = plateEndFi - Math.round(videoInfo.fps);
              const reachesTop = covered
                .filter((fi) => fi >= closingStart)
                .some((fi) => {
                  const polys = trackPolygons.get(fi);
                  return polys?.length
                    ? Math.min(...polys[0].map(([, y]) => y)) <= 5
                    : false;
                });
              expect(reachesTop).toBe(true);
            },
          );

          it.skipIf(SKIP_INTEGRATION || !hasExits?.includes("bottom"))(
            "covers the plate during exit if it exits from the bottom of the frame",
            () => {
              const { endFi: plateEndFi } = plateFrameWindow(
                plate,
                tracks,
                videoInfo.fps,
                visibleFrom,
                visibleUntil,
              );
              const covered = coveredFramesInWindow(
                0,
                plateEndFi,
                trackPolygons,
              );
              const closingStart = plateEndFi - Math.round(videoInfo.fps);
              const reachesBottom = covered
                .filter((fi) => fi >= closingStart)
                .some((fi) => {
                  const polys = trackPolygons.get(fi);
                  return polys?.length
                    ? Math.max(...polys[0].map(([, y]) => y)) >=
                        videoInfo.height - 5
                    : false;
                });
              expect(reachesBottom).toBe(true);
            },
          );

          it.skipIf(SKIP_INTEGRATION || !hasExits?.includes("left"))(
            "covers the plate during exit if it exits from the left of the frame",
            () => {
              const { endFi: plateEndFi } = plateFrameWindow(
                plate,
                tracks,
                videoInfo.fps,
                visibleFrom,
                visibleUntil,
              );
              const covered = coveredFramesInWindow(
                0,
                plateEndFi,
                trackPolygons,
              );
              const closingStart = plateEndFi - Math.round(videoInfo.fps);
              const reachesLeft = covered
                .filter((fi) => fi >= closingStart)
                .some((fi) => {
                  const polys = trackPolygons.get(fi);
                  return polys?.length
                    ? Math.min(...polys[0].map(([x]) => x)) <= 5
                    : false;
                });
              expect(reachesLeft).toBe(true);
            },
          );

          it.skipIf(SKIP_INTEGRATION || !hasExits?.includes("right"))(
            "covers the plate during exit if it exits from the right of the frame",
            () => {
              const { endFi: plateEndFi } = plateFrameWindow(
                plate,
                tracks,
                videoInfo.fps,
                visibleFrom,
                visibleUntil,
              );
              const covered = coveredFramesInWindow(
                0,
                plateEndFi,
                trackPolygons,
              );
              const closingStart = plateEndFi - Math.round(videoInfo.fps);
              const reachesRight = covered
                .filter((fi) => fi >= closingStart)
                .some((fi) => {
                  const polys = trackPolygons.get(fi);
                  return polys?.length
                    ? Math.max(...polys[0].map(([x]) => x)) >=
                        videoInfo.width - 5
                    : false;
                });
              expect(reachesRight).toBe(true);
            },
          );

          it.skipIf(SKIP_INTEGRATION)(
            "obscures the plate region without readable text remaining",
            async () => {
              const { startFi, endFi: plateEndFi } = plateFrameWindow(
                plate,
                tracks,
                videoInfo.fps,
                visibleFrom,
                visibleUntil,
              );
              const covered = coveredFramesInWindow(
                startFi,
                plateEndFi,
                trackPolygons,
              );
              if (covered.length === 0) return;

              // Sample up to 8 frames spread evenly across the visible window.
              const N = 8;
              const step = Math.max(1, Math.floor(covered.length / N));
              const sampleFrames = covered
                .filter((_, i) => i % step === 0)
                .slice(0, N);

              const worker = await createWorker("eng");
              try {
                for (const fi of sampleFrames) {
                  const obscuredPath = path.join(
                    obscureDir,
                    path.basename(frames[fi].filePath),
                  );
                  if (!fs.existsSync(obscuredPath)) continue;

                  const coveragePolygons = trackPolygons.get(fi)!;
                  if (!coveragePolygons.length) continue;

                  const allPts = coveragePolygons.flat();
                  const covLeft = Math.max(
                    0,
                    Math.min(...allPts.map(([x]) => x)) - 10,
                  );
                  const covTop = Math.max(
                    0,
                    Math.min(...allPts.map(([, y]) => y)) - 10,
                  );
                  const covRight = Math.min(
                    videoInfo.width,
                    Math.max(...allPts.map(([x]) => x)) + 10,
                  );
                  const covBottom = Math.min(
                    videoInfo.height,
                    Math.max(...allPts.map(([, y]) => y)) + 10,
                  );
                  const cropW = covRight - covLeft;
                  const cropH = covBottom - covTop;
                  if (cropW < 4 || cropH < 4) continue;

                  const cropPath = path.join(tmpDir, `ocr-crop-${fi}.jpg`);
                  await sharp(obscuredPath)
                    .extract({
                      left: covLeft,
                      top: covTop,
                      width: cropW,
                      height: cropH,
                    })
                    .jpeg({ quality: 95 })
                    .toFile(cropPath);

                  const result = await worker.recognize(cropPath);

                  const readableAlphanumChars = (result.data.blocks ?? [])
                    .flatMap((b) => b.paragraphs)
                    .flatMap((p) => p.lines)
                    .flatMap((l) => l.words)
                    .filter((w) => w.confidence > 50)
                    .map((w) => w.text.replace(/[^a-zA-Z0-9]/g, ""))
                    .filter((t) => t.length >= 2)
                    .join("");

                  expect(readableAlphanumChars).toBe("");
                }
              } finally {
                await worker.terminate();
              }
            },
          );
        });
      }
    });
  }

  it.skipIf(!SKIP_INTEGRATION)(
    "skips gracefully when RUN_INTEGRATION_TESTS is not set",
    () => {
      expect(SKIP_INTEGRATION).toBe(true);
    },
  );
});
