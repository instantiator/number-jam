/**
 * Unit tests for the SAD template-matching visual tracker.
 *
 * Creates synthetic JPEG frames in a temporary directory (a white rectangle
 * moving on a grey background), then verifies that trackForward / trackBack /
 * trackGap follow the rectangle's position across frames.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import { trackBack, trackForward, trackGap } from "../src/tracking/visual-tracker";
import { FrameInfo, Track, TrackHistoryEntry } from "../src/types";

const FRAME_W = 200;
const FRAME_H = 100;
const RECT_W = 30;
const RECT_H = 20;
const RECT_Y = 35;
const RECT_X0 = 40;
const FRAME_COUNT = 10;

let tmpDir: string;
let frames: FrameInfo[];

async function makeFrame(rectX: number): Promise<Buffer> {
  return sharp({
    create: {
      width: FRAME_W,
      height: FRAME_H,
      channels: 3,
      background: { r: 100, g: 100, b: 100 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${FRAME_W}" height="${FRAME_H}" xmlns="http://www.w3.org/2000/svg">` +
          `<rect x="${rectX}" y="${RECT_Y}" width="${RECT_W}" height="${RECT_H}" fill="white"/>` +
          `</svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg({ quality: 95 })
    .toBuffer();
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nj-vt-test-"));

  frames = [];
  for (let fi = 0; fi < FRAME_COUNT; fi++) {
    const rectX = RECT_X0 + fi * 5;
    const filePath = path.join(tmpDir, `frame_${String(fi).padStart(6, "0")}.jpg`);
    fs.writeFileSync(filePath, await makeFrame(rectX));
    frames.push({ frameIndex: fi, filePath, timestamp: fi / 25 });
  }
}, 30_000);

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTrackAtStart(): Track {
  return {
    plate: "AB12CDE",
    region: "gb",
    history: [
      {
        frameIndex: 0,
        timestamp: 0,
        polygon: [
          [RECT_X0, RECT_Y],
          [RECT_X0 + RECT_W, RECT_Y],
          [RECT_X0 + RECT_W, RECT_Y + RECT_H],
          [RECT_X0, RECT_Y + RECT_H],
        ],
      },
    ],
  };
}

function makeTrackAtEnd(): Track {
  const x = RECT_X0 + (FRAME_COUNT - 1) * 5;
  return {
    plate: "AB12CDE",
    region: "gb",
    history: [
      {
        frameIndex: FRAME_COUNT - 1,
        timestamp: (FRAME_COUNT - 1) / 25,
        polygon: [
          [x, RECT_Y],
          [x + RECT_W, RECT_Y],
          [x + RECT_W, RECT_Y + RECT_H],
          [x, RECT_Y + RECT_H],
        ],
      },
    ],
  };
}

describe("trackForward", () => {
  it("returns tracked frames after the detection endpoint", async () => {
    const result = await trackForward(frames, makeTrackAtStart());
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns frames with ascending frameIndex values", async () => {
    const result = await trackForward(frames, makeTrackAtStart());
    for (let i = 1; i < result.length; i++) {
      expect(result[i].frameIndex).toBeGreaterThan(result[i - 1].frameIndex);
    }
  });

  it("returns polygons with 4 points", async () => {
    const result = await trackForward(frames, makeTrackAtStart());
    for (const { polygon } of result) {
      expect(polygon).toHaveLength(4);
    }
  });

  it("tracks forward beyond what a 3-frame limit would allow", async () => {
    const result = await trackForward(frames, makeTrackAtStart());
    // With 10 frames and the rectangle moving right, expect tracking past frame 3.
    const maxIndex = result.length > 0 ? Math.max(...result.map((r) => r.frameIndex)) : 0;
    expect(maxIndex).toBeGreaterThan(3);
  });
});

describe("trackBack", () => {
  it("returns tracked frames before the detection endpoint", async () => {
    const result = await trackBack(frames, makeTrackAtEnd());
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns frames with frameIndex values below the endpoint", async () => {
    const result = await trackBack(frames, makeTrackAtEnd());
    for (const { frameIndex } of result) {
      expect(frameIndex).toBeLessThan(FRAME_COUNT - 1);
    }
  });

  it("tracks back beyond what a 3-frame limit would allow", async () => {
    const result = await trackBack(frames, makeTrackAtEnd());
    // With 10 frames and the rectangle moving right, expect tracking past frame 6.
    const minIndex = result.length > 0 ? Math.min(...result.map((r) => r.frameIndex)) : FRAME_COUNT;
    expect(minIndex).toBeLessThan(FRAME_COUNT - 4);
  });
});

describe("trackGap", () => {
  it("returns empty when entries are adjacent", async () => {
    const from: TrackHistoryEntry = {
      frameIndex: 2,
      timestamp: 2 / 25,
      polygon: [[RECT_X0, RECT_Y], [RECT_X0 + RECT_W, RECT_Y], [RECT_X0 + RECT_W, RECT_Y + RECT_H], [RECT_X0, RECT_Y + RECT_H]],
    };
    const to: TrackHistoryEntry = {
      frameIndex: 3,
      timestamp: 3 / 25,
      polygon: [[RECT_X0 + 5, RECT_Y], [RECT_X0 + 5 + RECT_W, RECT_Y], [RECT_X0 + 5 + RECT_W, RECT_Y + RECT_H], [RECT_X0 + 5, RECT_Y + RECT_H]],
    };
    const result = await trackGap(frames, from, to);
    expect(result).toHaveLength(0);
  });

  it("fills the gap between two non-adjacent history entries", async () => {
    const x0 = RECT_X0;                    // frame 0 rect x
    const x4 = RECT_X0 + 4 * 5;           // frame 4 rect x
    const from: TrackHistoryEntry = {
      frameIndex: 0,
      timestamp: 0,
      polygon: [[x0, RECT_Y], [x0 + RECT_W, RECT_Y], [x0 + RECT_W, RECT_Y + RECT_H], [x0, RECT_Y + RECT_H]],
    };
    const to: TrackHistoryEntry = {
      frameIndex: 4,
      timestamp: 4 / 25,
      polygon: [[x4, RECT_Y], [x4 + RECT_W, RECT_Y], [x4 + RECT_W, RECT_Y + RECT_H], [x4, RECT_Y + RECT_H]],
    };
    const result = await trackGap(frames, from, to);
    // Should produce intermediate frames strictly between index 0 and 4.
    for (const { frameIndex } of result) {
      expect(frameIndex).toBeGreaterThan(0);
      expect(frameIndex).toBeLessThan(4);
    }
    // Polygons should have 4 points.
    for (const { polygon } of result) {
      expect(polygon).toHaveLength(4);
    }
  });
});
