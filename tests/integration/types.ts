/**
 * Metadata file format for a video fixture used in plate-coverage integration tests.
 * Stored alongside each `.mp4` as `<filename>.metadata.json`.
 */
export interface TestVideoMetadata {
  expectations: TestPlateExpectation[];
}

/**
 * Expected behaviour for a single number plate within the test video.
 */
export interface TestPlateExpectation {
  /** Canonical plate text as read by ANPR (case-insensitive match against track.plate). */
  plate: string;
  /** Seconds into the clip at which the plate first becomes visible (approximation). */
  visibleFrom?: number;
  /** Seconds into the clip at which the plate last remains visible (approximation). */
  visibleUntil?: number;
  /** Frame edges the plate enters from (triggers corresponding entry-coverage assertions). */
  hasEntries?: ("left" | "right" | "top" | "bottom")[];
  /** Frame edges the plate exits from (triggers corresponding exit-coverage assertions). */
  hasExits?: ("left" | "right" | "top" | "bottom")[];
}
