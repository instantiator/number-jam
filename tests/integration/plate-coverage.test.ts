/**
 * Integration test for plate-coverage quality on a real video clip.
 *
 * Cuts a 9 s – 20 s window from the user's recording, runs the full detection,
 * tracking, and obscuring pipeline, then asserts:
 *
 *   a) Minimum coverage — at least 4 s worth of frames have a coverage polygon.
 *   b) No large gaps — consecutive covered frames never leave a gap > 1 s during
 *      the plate-visible window (approx. 3 s into the clip onward).
 *   c) Anti-flicker — the bounding-box area of the coverage polygon does not
 *      change by more than 60 % between adjacent covered frames.
 *   d) Top-edge coverage — for any frame where ANPR detected the plate with its
 *      top polygon edge within 10 px of y = 0, the coverage polygon's minimum
 *      y coordinate must be ≤ 5 px (so the obscured region starts flush with
 *      the top of the frame).
 *   e) All covered frames are present in the obscured output directory.
 *   f) Obscured plate regions contain no readable alphanumeric text (verified
 *      with tesseract.js OCR on the actual output frames).
 *
 * Skipped unless both RUN_INTEGRATION_TESTS=1 and the source video exist.
 * The source video is the user's own recording and is not a downloadable fixture.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execFileSync } from "child_process";
import ffmpegStatic from "ffmpeg-static";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { DockerAlprEngine } from "../../src/detection/engines/docker-alpr";
import {
  runExtraction,
  runPreProcessing,
  runDetection,
  runTrackBuilding,
  runTrackCoverage,
  runObscuring,
} from "../../src/cli/phases";
import { runCharacterScan } from "../../src/cli/character-scan";
import { Point } from "../../src/types";

// Source video — not a public fixture, lives in the repo working tree.
const SOURCE_VIDEO = path.resolve(process.cwd(), "temp/VID_20260609_122553.mp4");
const CLIP_START_SEC = 9;
const CLIP_DURATION_SEC = 11;  // 9 s → 20 s in the original video

// Plate enters the camera frame at approximately original 12 s (clip 3 s).
// ANPR typically detects the plate at approximately original 18–19 s (clip 9–10 s).
// Backward tracking + velocity extrapolation should cover the entry window.
const PLATE_VISIBLE_CLIP_SEC = 3;  // seconds into the clip when plate appears

const SKIP_INTEGRATION = !process.env["RUN_INTEGRATION_TESTS"];
const SKIP_NO_SOURCE = !fs.existsSync(SOURCE_VIDEO);
const SKIP = SKIP_INTEGRATION || SKIP_NO_SOURCE;

let tmpDir: string;
let engine: DockerAlprEngine;

beforeAll(async () => {
  if (SKIP) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nj-coverage-test-"));
}, 10_000);

afterAll(async () => {
  if (SKIP) return;
  await engine?.shutdown().catch(() => undefined);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}, 30_000);

// Helper: axis-aligned bounding box from a polygon.
function bbox(polygon: Point[]): { left: number; top: number; right: number; bottom: number } {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

function bboxArea(polygon: Point[]): number {
  const b = bbox(polygon);
  return Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
}

describe("plate-coverage integration", () => {
  it.skipIf(SKIP)(
    "covers the plate during entry from the top of the frame without flicker or gaps",
    async () => {
      // --- Cut the clip ---
      const clipPath = path.join(tmpDir, "clip.mp4");
      execFileSync(ffmpegStatic!, [
        "-y",
        "-ss", String(CLIP_START_SEC),
        "-i", SOURCE_VIDEO,
        "-t", String(CLIP_DURATION_SEC),
        "-c", "copy",
        clipPath,
      ]);

      // --- Run pipeline ---
      const framesDir = path.join(tmpDir, "frames");
      fs.mkdirSync(framesDir);

      engine = new DockerAlprEngine(0);
      await engine.check();
      await engine.startup();

      const { frames, videoInfo } = await runExtraction(clipPath, framesDir);
      await runPreProcessing(frames, videoInfo.width);
      const rawFrameResults = await runDetection(frames, ["gb"], engine);
      const frameResults = await runCharacterScan(frames, rawFrameResults, videoInfo.width, videoInfo.height);
      const tracks = runTrackBuilding(frameResults, videoInfo.fps);

      const fps = videoInfo.fps;
      const extendFrames = Math.round(fps * 12);  // generous 12 s backward window
      const trackPolygons = await runTrackCoverage(
        tracks,
        frames,
        extendFrames,
        videoInfo.width,
        videoInfo.height,
        fps,
      );

      // --- Assertion (a): minimum coverage ---
      const minCoverageFrames = Math.round(fps * 4);
      expect(trackPolygons.size).toBeGreaterThanOrEqual(minCoverageFrames);

      // --- Assertion (b): no large gap during plate-visible window ---
      const visibleStartFi = Math.round(PLATE_VISIBLE_CLIP_SEC * fps);
      const coveredInWindow = [...trackPolygons.keys()]
        .filter((fi) => fi >= visibleStartFi)
        .sort((a, b) => a - b);

      const maxGapAllowed = Math.round(fps);  // 1 s
      for (let i = 1; i < coveredInWindow.length; i++) {
        const gap = coveredInWindow[i] - coveredInWindow[i - 1];
        expect(gap).toBeLessThanOrEqual(maxGapAllowed);
      }

      // --- Assertion (c): anti-flicker ---
      const allCovered = [...trackPolygons.keys()].sort((a, b) => a - b);
      for (let i = 1; i < allCovered.length; i++) {
        const prev = allCovered[i - 1];
        const cur = allCovered[i];
        if (cur - prev !== 1) continue;  // only check consecutive frames

        const prevPolygons = trackPolygons.get(prev)!;
        const curPolygons = trackPolygons.get(cur)!;
        if (!prevPolygons.length || !curPolygons.length) continue;

        const prevArea = bboxArea(prevPolygons[0]);
        const curArea = bboxArea(curPolygons[0]);
        if (prevArea === 0 || curArea === 0) continue;

        const changeRatio = Math.abs(curArea - prevArea) / prevArea;
        expect(changeRatio).toBeLessThan(0.6);
      }

      // --- Assertion (d): top-edge coverage for detected frames ---
      // For every frame where ANPR detected a plate near the top of the frame,
      // the coverage polygon's min-y must be ≤ 5 px (flush with frame top after
      // the velocity-extension fix in phases.ts).
      const frameResultByIndex = new Map(frameResults.map((fr) => [fr.frameIndex, fr]));
      const detectedNearTop = new Map<number, Point[][]>();
      for (const [fi, fr] of frameResultByIndex) {
        const nearTopDets = fr.detections.filter((det) => {
          const minY = Math.min(...det.polygon.map(([, y]) => y));
          return minY < 10;
        });
        if (nearTopDets.length > 0) {
          detectedNearTop.set(fi, nearTopDets.map((d) => d.polygon));
        }
      }
      for (const fi of detectedNearTop.keys()) {
        const polygons = trackPolygons.get(fi);
        if (!polygons || polygons.length === 0) continue;
        const coverageMinY = Math.min(...polygons[0].map(([, y]) => y));
        // Coverage polygon should start at or above y = 5 (SVG clips negative
        // values to y = 0, so negative minY is fine too).
        expect(coverageMinY).toBeLessThanOrEqual(5);
      }

      // --- Run obscuring ---
      const obscureDir = path.join(tmpDir, "obscured");
      fs.mkdirSync(obscureDir);
      await runObscuring(frames, trackPolygons, obscureDir);

      // --- Assertion (e): all covered frames have an output file ---
      for (const fi of trackPolygons.keys()) {
        const basename = path.basename(frames[fi].filePath);
        expect(fs.existsSync(path.join(obscureDir, basename))).toBe(true);
      }

      // --- Assertion (f): obscured plate regions contain no readable text ---
      // Sample covered frames spread evenly across the full plate-visible window
      // (not just ANPR detection frames). This catches failures in velocity-
      // extrapolated or visual-tracking-extended frames where characters may
      // still be visible even though ANPR never fired there.
      {
        const visibleCoveredFrames = [...trackPolygons.keys()]
          .filter((fi) => fi >= visibleStartFi)
          .sort((a, b) => a - b);

        if (visibleCoveredFrames.length > 0) {
          const worker = await createWorker("eng");
          try {
            // Sample up to 8 frames spread evenly across the visible window.
            const N = 8;
            const step = Math.max(1, Math.floor(visibleCoveredFrames.length / N));
            const sampleFrames = visibleCoveredFrames.filter((_, i) => i % step === 0).slice(0, N);

            for (const fi of sampleFrames) {
              const obscuredPath = path.join(obscureDir, path.basename(frames[fi].filePath));
              if (!fs.existsSync(obscuredPath)) continue;

              const coveragePolygons = trackPolygons.get(fi)!;
              if (!coveragePolygons.length) continue;

              // Crop the coverage polygon bbox (with padding) from the obscured frame.
              const allPts = coveragePolygons.flat();
              const covLeft = Math.max(0, Math.min(...allPts.map(([x]) => x)) - 10);
              const covTop = Math.max(0, Math.min(...allPts.map(([, y]) => y)) - 10);
              const covRight = Math.min(videoInfo.width, Math.max(...allPts.map(([x]) => x)) + 10);
              const covBottom = Math.min(videoInfo.height, Math.max(...allPts.map(([, y]) => y)) + 10);
              const cropW = covRight - covLeft;
              const cropH = covBottom - covTop;
              if (cropW < 4 || cropH < 4) continue;

              const cropPath = path.join(tmpDir, `ocr-crop-${fi}.jpg`);
              await sharp(obscuredPath)
                .extract({ left: covLeft, top: covTop, width: cropW, height: cropH })
                .jpeg({ quality: 95 })
                .toFile(cropPath);

              const result = await worker.recognize(cropPath);

              const words = (result.data.blocks ?? [])
                .flatMap((b) => b.paragraphs)
                .flatMap((p) => p.lines)
                .flatMap((l) => l.words)
                .filter((w) => w.confidence > 50);

              const readableAlphanumChars = words
                .map((w) => w.text.replace(/[^a-zA-Z0-9]/g, ""))
                .filter((t) => t.length >= 2)
                .join("");

              expect(readableAlphanumChars).toBe(
                "",
                `Frame ${fi}: tesseract found readable plate text "${readableAlphanumChars}" in obscured coverage region`,
              );
            }
          } finally {
            await worker.terminate();
          }
        }
      }
    },
    1_200_000,  // 20 min — Docker startup + ANPR + character scan + obscuring + OCR
  );

  it.skipIf(SKIP_INTEGRATION)(
    "skips gracefully when source video is absent",
    () => {
      if (!SKIP_NO_SOURCE) {
        // Source exists — this test is vacuously true.
        return;
      }
      // If source is missing, the guard above skips the main test.
      // This test just documents that expectation.
      expect(SKIP_NO_SOURCE).toBe(true);
    },
  );
});
