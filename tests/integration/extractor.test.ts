/**
 * Integration test for the frame extractor.
 *
 * Verifies that extractFrames() produces at least one JPEG from a short
 * real-world video clip and that frame timestamps are non-decreasing.
 *
 * Skipped unless RUN_INTEGRATION_TESTS=1 is set.
 * Fixture: tests/fixtures/bbb-10s.mp4 (CC-BY 3.0, Blender Foundation)
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { extractFrames, getVideoInfo } from "../../src/video/extractor";

const FIXTURE = path.resolve(__dirname, "../fixtures/bbb-10s.mp4");
const SKIP = !process.env["RUN_INTEGRATION_TESTS"];

describe("frame extractor integration", () => {
  beforeAll(() => {
    if (SKIP) return;
    if (!fs.existsSync(FIXTURE)) {
      throw new Error(
        `Fixture missing: ${FIXTURE}\nRun: npm run download-fixtures`
      );
    }
  });

  it.skipIf(SKIP)("extracts at least one JPEG from bbb-10s.mp4", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nj-test-"));
    try {
      const frames = await extractFrames(FIXTURE, tmpDir);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(fs.existsSync(frame.filePath)).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(SKIP)("frame timestamps are non-decreasing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nj-test-"));
    try {
      const frames = await extractFrames(FIXTURE, tmpDir);
      for (let i = 1; i < frames.length; i++) {
        expect(frames[i].timestamp).toBeGreaterThanOrEqual(frames[i - 1].timestamp);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(SKIP)("getVideoInfo returns positive fps and duration", async () => {
    const info = await getVideoInfo(FIXTURE);
    expect(info.fps).toBeGreaterThan(0);
    expect(info.durationSeconds).toBeGreaterThan(0);
    expect(info.frameCount).toBeGreaterThan(0);
  }, 30_000);
});
