/**
 * A single [x, y] coordinate pair describing a point in image space.
 */
export type Point = [number, number];

/**
 * A padding amount for polygon expansion, expressed as either an absolute pixel
 * count or a percentage of the polygon's own width or height.
 */
export interface PaddingSpec {
  /** The numeric amount. */
  value: number;
  /** Whether {@link value} is an absolute pixel count or a percentage of the relevant dimension. */
  unit: "px" | "%";
}

/**
 * A detected number plate within a single video frame.
 */
export interface PlateDetection {
  /** The recognised plate text; empty string when the plate region is visible but unreadable. */
  plate: string;
  /** OpenALPR confidence score 0–100. */
  confidence: number;
  /** ISO region/country code returned by OpenALPR (e.g. "gb", "us-ca"). Null when unknown. */
  region: string | null;
  /** Confidence in the region classification 0–100. */
  regionConfidence: number;
  /** Clockwise polygon vertices enclosing the plate. Usually 4 points (quadrilateral). */
  polygon: Point[];
  /** Zero-based index of the frame this detection belongs to. */
  frameIndex: number;
}

/**
 * All detections found in a single frame.
 */
export interface FrameResult {
  frameIndex: number;
  filePath: string;
  /** Seconds from the start of the video. */
  timestamp: number;
  detections: PlateDetection[];
}

/**
 * Metadata about a single extracted video frame.
 */
export interface FrameInfo {
  frameIndex: number;
  filePath: string;
  /** Seconds from the start of the video. */
  timestamp: number;
}

/**
 * A single entry in a track's position history.
 */
export interface TrackHistoryEntry {
  frameIndex: number;
  /** Seconds from the start of the video. */
  timestamp: number;
  /** Clockwise polygon vertices for this frame. May be interpolated between actual detections. */
  polygon: Point[];
}

/**
 * A plate tracked across multiple frames.
 */
export interface Track {
  /** Canonical plate text (empty string for partial/unreadable plates). */
  plate: string;
  /** Best-confidence region code for this track. Null when unknown. */
  region: string | null;
  /** Ordered position history across frames (contiguous, with gaps interpolated). */
  history: TrackHistoryEntry[];
}

/**
 * The request parameters echoed into the output document.
 */
export interface RequestInfo {
  path: string;
  regions: string[];
  obscure: boolean;
  /** When true, the full per-frame tracking history is included in the output. */
  verbose: boolean;
}

/**
 * A deduplicated plate summary entry.
 */
export interface PlateSummary {
  plate: string;
  region: string | null;
  /** Earliest timestamp (ms from video start) the plate appears across all tracks. */
  trackedFrom: number;
  /** Latest timestamp (ms from video start) the plate appears across all tracks. */
  trackedUntil: number;
}

/**
 * The top-level JSON output document written to stdout.
 */
export interface OutputDoc {
  request: RequestInfo;
  summary: PlateSummary[];
  /** Full per-frame tracking history. Empty array when --verbose is not set. */
  tracking: Array<{
    plate: string;
    /** Timestamps are milliseconds from the video start, rounded to the nearest integer. */
    history: Array<{ timestamp: number; polygon: Point[] }>;
  }>;
  /** Duration of the input video in milliseconds, rounded to the nearest integer. */
  videoDuration: number;
  /** Total wall-clock processing time in milliseconds. */
  processingDuration: number;
  /** Resolved path to the output video, or null when obscuring was not performed. */
  output: string | null;
}
