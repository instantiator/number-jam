/**
 * Orchestrates plate detection across all extracted video frames.
 *
 * Delegates the actual detection work to the supplied {@link DetectionEngine} so the
 * frame-iteration logic stays independent of the chosen ANPR backend. Frames are
 * processed concurrently up to {@link DetectOptions.concurrency}.
 */

import pLimit from "p-limit";
import { DetectionEngine } from "./engine";
import { FrameInfo, FrameResult } from "../types";

/** Options for {@link detectAllFrames}. */
export interface DetectOptions {
  /** Maximum number of concurrent engine requests (default: 4). */
  concurrency?: number;
  /** Called after each frame completes with the running completed count and total. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Run the engine on every frame in the list and return per-frame results in
 * the same order as the input array.
 *
 * @param frames   Frames to scan (from extractor.extractFrames).
 * @param regions  Region codes to filter to, or ["*"] / [] for all regions.
 * @param engine   The ANPR backend to use for each frame.
 * @param options  Concurrency and progress options.
 */
export async function detectAllFrames(
  frames: FrameInfo[],
  regions: string[],
  engine: DetectionEngine,
  options?: DetectOptions,
): Promise<FrameResult[]> {
  const total = frames.length;
  const limit = pLimit(options?.concurrency ?? 4);
  let done = 0;

  return Promise.all(
    frames.map((frame) =>
      limit(async () => {
        const detections = await engine.detectPlates(frame.filePath, frame.frameIndex, regions);

        /** Post-filter by region when multiple specific regions were requested. */
        const filtered =
          regions.length > 0 && !regions.includes("*")
            ? detections.filter(
                (d) =>
                  d.region === null ||
                  regions.some((r) => d.region === r || d.region?.startsWith(r + "-"))
              )
            : detections;

        options?.onProgress?.(++done, total);

        return {
          frameIndex: frame.frameIndex,
          filePath: frame.filePath,
          timestamp: frame.timestamp,
          detections: filtered,
        };
      }),
    ),
  );
}
