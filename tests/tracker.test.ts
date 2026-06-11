/**
 * Unit tests for the IOU-based tracker.
 *
 * These tests verify the core assignment, gap-filling, and track-closing logic
 * using synthetic frame results — no real video or OpenALPR invocation needed.
 */

import { describe, it, expect } from "vitest";
import { buildTracks } from "../src/tracking/tracker";
import { FrameResult } from "../src/types";

/** Helper to build a minimal FrameResult with one detection. */
function frame(
  frameIndex: number,
  plate: string,
  x: number,
  y: number,
  w: number,
  h: number,
  region: string | null = null
): FrameResult {
  return {
    frameIndex,
    filePath: `frame_${String(frameIndex).padStart(6, "0")}.jpg`,
    timestamp: frameIndex / 25,
    detections: [
      {
        plate,
        confidence: 90,
        region,
        regionConfidence: region ? 80 : 0,
        polygon: [
          [x, y],
          [x + w, y],
          [x + w, y + h],
          [x, y + h],
        ],
        frameIndex,
      },
    ],
  };
}

/** Empty frame with no detections. */
function emptyFrame(frameIndex: number): FrameResult {
  return {
    frameIndex,
    filePath: `frame_${String(frameIndex).padStart(6, "0")}.jpg`,
    timestamp: frameIndex / 25,
    detections: [],
  };
}

describe("buildTracks", () => {
  it("returns an empty array when there are no detections", () => {
    const results = [emptyFrame(0), emptyFrame(1), emptyFrame(2)];
    expect(buildTracks(results, 25)).toEqual([]);
  });

  it("creates one track for a plate that appears in consecutive frames", () => {
    const results = [
      frame(0, "AB12CDE", 100, 100, 80, 30),
      frame(1, "AB12CDE", 102, 101, 80, 30),
      frame(2, "AB12CDE", 104, 102, 80, 30),
    ];
    const tracks = buildTracks(results, 25);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].plate).toBe("AB12CDE");
    expect(tracks[0].history).toHaveLength(3);
  });

  it("creates separate tracks for plates that don't overlap", () => {
    const results = [
      {
        frameIndex: 0,
        filePath: "frame_000000.jpg",
        timestamp: 0,
        detections: [
          {
            plate: "AB12CDE",
            confidence: 90,
            region: "gb",
            regionConfidence: 80,
            polygon: [
              [0, 0],
              [80, 0],
              [80, 30],
              [0, 30],
            ],
            frameIndex: 0,
          },
          {
            plate: "XY34FGH",
            confidence: 90,
            region: "gb",
            regionConfidence: 80,
            polygon: [
              [500, 500],
              [580, 500],
              [580, 530],
              [500, 530],
            ],
            frameIndex: 0,
          },
        ],
      },
    ];
    const tracks = buildTracks(results, 25);
    expect(tracks).toHaveLength(2);
    const plates = tracks.map((t) => t.plate).sort();
    expect(plates).toEqual(["AB12CDE", "XY34FGH"]);
  });

  it("closes a track and opens a new one when the same plate reappears far from the old position", () => {
    const results = [
      frame(0, "AB12CDE", 100, 100, 80, 30),
      frame(1, "AB12CDE", 900, 500, 80, 30), // Completely different location → new track
    ];
    const tracks = buildTracks(results, 25);
    // IOU between boxes at (100,100) and (900,500) is 0 → separate tracks
    expect(tracks).toHaveLength(2);
  });

  it("fills a short gap between two detections with interpolated entries", () => {
    const results = [
      frame(0, "AB12CDE", 100, 100, 80, 30),
      emptyFrame(1),
      emptyFrame(2),
      frame(3, "AB12CDE", 106, 103, 80, 30),
    ];
    const tracks = buildTracks(results, 25);
    expect(tracks).toHaveLength(1);
    // History should include all 4 frame positions (gap filled)
    expect(tracks[0].history).toHaveLength(4);
    expect(tracks[0].history[0].frameIndex).toBe(0);
    expect(tracks[0].history[3].frameIndex).toBe(3);
  });

  it("closes a track after MAX_GAP_FRAMES consecutive missing frames", () => {
    const results: FrameResult[] = [frame(0, "AB12CDE", 100, 100, 80, 30)];
    // Add 20 empty frames (> MAX_GAP_FRAMES which is 15)
    for (let i = 1; i <= 20; i++) results.push(emptyFrame(i));
    results.push(frame(21, "AB12CDE", 100, 100, 80, 30));

    const tracks = buildTracks(results, 25);
    // The long gap should close the first track and open a new one
    expect(tracks).toHaveLength(2);
  });

  it("upgrades a partial-plate track when a readable detection arrives", () => {
    // First detection: unreadable plate at the same location
    const results = [
      {
        frameIndex: 0,
        filePath: "frame_000000.jpg",
        timestamp: 0,
        detections: [
          {
            plate: "",
            confidence: 40,
            region: null,
            regionConfidence: 0,
            polygon: [
              [100, 100],
              [180, 100],
              [180, 130],
              [100, 130],
            ],
            frameIndex: 0,
          },
        ],
      },
      {
        frameIndex: 1,
        filePath: "frame_000001.jpg",
        timestamp: 1 / 25,
        detections: [
          {
            plate: "AB12CDE",
            confidence: 90,
            region: "gb",
            regionConfidence: 80,
            polygon: [
              [101, 100],
              [181, 100],
              [181, 130],
              [101, 130],
            ],
            frameIndex: 1,
          },
        ],
      },
    ];
    const tracks = buildTracks(results, 25);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].plate).toBe("AB12CDE");
  });

  it("assigns correct timestamps from fps", () => {
    const fps = 30;
    const results = [frame(0, "AB12CDE", 100, 100, 80, 30)];
    const tracks = buildTracks(results, fps);
    expect(tracks[0].history[0].timestamp).toBeCloseTo(0 / fps);
  });

  it("does not re-match a track that is older than MAX_GAP_FRAMES, creating a new track instead", () => {
    // MAX_GAP_FRAMES is 15; skip 16 empty frames between the two detections so
    // the old track is stale and the continue branch fires in findBestMatch.
    const results: FrameResult[] = [frame(0, "AB12CDE", 100, 100, 80, 30)];
    for (let i = 1; i <= 16; i++) results.push(emptyFrame(i));
    results.push(frame(17, "AB12CDE", 100, 100, 80, 30));

    const tracks = buildTracks(results, 25);
    expect(tracks).toHaveLength(2);
    expect(tracks[0].plate).toBe("AB12CDE");
    expect(tracks[1].plate).toBe("AB12CDE");
  });
});
