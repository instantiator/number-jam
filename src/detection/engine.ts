import { PlateDetection } from "../types";

/**
 * Common interface for all ANPR detection backends.
 *
 * Implementations handle their own lifecycle: verifying prerequisites,
 * starting any required services, performing per-frame detection, and
 * tearing down cleanly when processing is complete.
 */
export interface DetectionEngine {
  /**
   * Verify that all prerequisites for this engine are available.
   * Throws a descriptive, actionable error if anything is missing.
   * Called once before startup().
   */
  check(): Promise<void>;

  /**
   * Start any background service required by this engine (e.g. a Docker
   * container or a Python daemon). Called once before the frame loop.
   */
  startup(): Promise<void>;

  /**
   * Detect all number plates in a single frame image.
   *
   * @param framePath  Absolute path to the JPEG frame file.
   * @param frameIndex Zero-based frame index echoed into each result.
   * @param regions    ISO region codes to filter detections; ["*"] or [] means all.
   */
  detectPlates(
    framePath: string,
    frameIndex: number,
    regions: string[]
  ): Promise<PlateDetection[]>;

  /**
   * Stop and clean up any background service started by startup().
   * Always called in a finally block — must not throw.
   */
  shutdown(): Promise<void>;
}
