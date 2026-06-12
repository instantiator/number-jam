import { Point, TrackHistoryEntry } from "../types.js";

/** Number of leading / trailing history entries sampled for velocity estimation. */
const VELOCITY_SAMPLE_COUNT = 3;

/** Compute the centroid [x, y] of a polygon. */
export function centroid(polygon: Point[]): [number, number] {
  const n = polygon.length;
  return [
    polygon.reduce((s, [x]) => s + x, 0) / n,
    polygon.reduce((s, [, y]) => s + y, 0) / n,
  ];
}

/**
 * Estimate per-frame velocity (dx, dy) from the first `count` history entries.
 * Uses the centroid displacement between the first and last of those entries
 * divided by the frame-index span. Returns [0, 0] for single-entry tracks.
 */
export function velocityFromHead(
  history: TrackHistoryEntry[],
  count = VELOCITY_SAMPLE_COUNT,
): [number, number] {
  if (history.length < 2) return [0, 0];
  const slice = history.slice(0, Math.min(count, history.length));
  const a = slice[0];
  const b = slice[slice.length - 1];
  const span = b.frameIndex - a.frameIndex;
  if (span === 0) return [0, 0];
  const [ax, ay] = centroid(a.polygon);
  const [bx, by] = centroid(b.polygon);
  return [(bx - ax) / span, (by - ay) / span];
}

/**
 * Estimate per-frame velocity (dx, dy) from the last `count` history entries.
 * Mirror of {@link velocityFromHead} for the exit end of a track.
 */
export function velocityFromTail(
  history: TrackHistoryEntry[],
  count = VELOCITY_SAMPLE_COUNT,
): [number, number] {
  if (history.length < 2) return [0, 0];
  const slice = history.slice(Math.max(0, history.length - count));
  const a = slice[0];
  const b = slice[slice.length - 1];
  const span = b.frameIndex - a.frameIndex;
  if (span === 0) return [0, 0];
  const [ax, ay] = centroid(a.polygon);
  const [bx, by] = centroid(b.polygon);
  return [(bx - ax) / span, (by - ay) / span];
}

/** Translate all polygon vertices by (dx, dy). */
export function shiftPolygon(polygon: Point[], dx: number, dy: number): Point[] {
  return polygon.map(([x, y]) => [x + dx, y + dy] as Point);
}
