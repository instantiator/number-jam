/**
 * Orchestrates plate detection across all extracted video frames.
 *
 * Delegates the actual detection work to the supplied DetectionEngine so the
 * frame-iteration logic stays independent of the chosen ANPR backend.
 */

import { DetectionEngine } from "./engine";
import { FrameInfo, FrameResult } from "../types";

/**
 * Run the engine on every frame in the list and return per-frame results.
 *
 * @param frames   Frames to scan (from extractor.extractFrames).
 * @param regions  Region codes to filter to, or ["*"] / [] for all regions.
 * @param engine   The ANPR backend to use for each frame.
 */
export async function detectAllFrames(
  frames: FrameInfo[],
  regions: string[],
  engine: DetectionEngine
): Promise<FrameResult[]> {
  const total = frames.length;
  const results: FrameResult[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    process.stderr.write(`Scanning frame ${i + 1}/${total} …\r`);

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

    results.push({
      frameIndex: frame.frameIndex,
      filePath: frame.filePath,
      timestamp: frame.timestamp,
      detections: filtered,
    });
  }

  process.stderr.write(`\nDetection complete: scanned ${total} frame(s)\n`);
  return results;
}
