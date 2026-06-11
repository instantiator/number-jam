/**
 * IOU-based multi-frame plate tracker.
 *
 * Groups per-frame PlateDetection objects into continuous tracks by matching
 * detections across frames using Intersection-over-Union (IOU) of their axis-
 * aligned bounding boxes, then interpolating polygon positions across gaps.
 *
 * Partial or unreadable plates (plate === "") are tracked separately from
 * legible plates; they appear in the output as tracks with plate === "".
 */

import { FrameResult, PlateDetection, Point, Track, TrackHistoryEntry } from "../types";

/** Minimum IOU score to consider two bounding boxes the same object. */
const IOU_THRESHOLD = 0.3;

/** Frames of absence before an active track is considered closed. */
const MAX_GAP_FRAMES = 15;

/** Internal mutable representation of an in-progress track. */
interface ActiveTrack {
  plate: string;
  region: string | null;
  regionConfidence: number;
  lastFrameIndex: number;
  entries: TrackHistoryEntry[];
}

/** Axis-aligned bounding box derived from a polygon. */
interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Compute the axis-aligned bounding box of a polygon. */
function bbox(polygon: Point[]): BBox {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** Compute IOU of two axis-aligned bounding boxes. */
function iou(a: BBox, b: BBox): number {
  const interMinX = Math.max(a.minX, b.minX);
  const interMinY = Math.max(a.minY, b.minY);
  const interMaxX = Math.min(a.maxX, b.maxX);
  const interMaxY = Math.min(a.maxY, b.maxY);

  const interW = Math.max(0, interMaxX - interMinX);
  const interH = Math.max(0, interMaxY - interMinY);
  const intersection = interW * interH;
  if (intersection === 0) return 0;

  const aArea = (a.maxX - a.minX) * (a.maxY - a.minY);
  const bArea = (b.maxX - b.minX) * (b.maxY - b.minY);
  return intersection / (aArea + bArea - intersection);
}

/** Linearly interpolate between two polygons at fraction t (0–1). */
function interpolatePolygon(a: Point[], b: Point[], t: number): Point[] {
  const len = Math.min(a.length, b.length);
  const result: Point[] = [];
  for (let i = 0; i < len; i++) {
    result.push([a[i][0] + (b[i][0] - a[i][0]) * t, a[i][1] + (b[i][1] - a[i][1]) * t]);
  }
  return result;
}

/**
 * Find the best matching active track for a detection, or null if none
 * exceeds the IOU threshold.
 */
function findBestMatch(
  detection: PlateDetection,
  tracks: ActiveTrack[],
  frameIndex: number
): ActiveTrack | null {
  const detBbox = bbox(detection.polygon);
  let bestTrack: ActiveTrack | null = null;
  let bestScore = IOU_THRESHOLD;

  for (const track of tracks) {
    // Only consider tracks that were active recently.
    if (frameIndex - track.lastFrameIndex > MAX_GAP_FRAMES) continue;

    // Plate text must match (or at least one side must be empty/partial).
    const plateMatch =
      track.plate === "" ||
      detection.plate === "" ||
      track.plate === detection.plate;
    if (!plateMatch) continue;

    const lastEntry = track.entries[track.entries.length - 1];
    const trackBbox = bbox(lastEntry.polygon);
    const score = iou(detBbox, trackBbox);

    if (score > bestScore) {
      bestScore = score;
      bestTrack = track;
    }
  }

  return bestTrack;
}

/**
 * Fill any frame gaps within a track's history via linear polygon interpolation,
 * and compute timestamps from fps.
 */
function fillGaps(track: ActiveTrack, fps: number): void {
  if (track.entries.length < 2) return;

  const filled: TrackHistoryEntry[] = [];

  for (let i = 0; i < track.entries.length - 1; i++) {
    const a = track.entries[i];
    const b = track.entries[i + 1];
    filled.push(a);

    const gap = b.frameIndex - a.frameIndex;
    for (let g = 1; g < gap; g++) {
      const t = g / gap;
      filled.push({
        frameIndex: a.frameIndex + g,
        timestamp: (a.frameIndex + g) / fps,
        polygon: interpolatePolygon(a.polygon, b.polygon, t),
      });
    }
  }
  filled.push(track.entries[track.entries.length - 1]);

  track.entries = filled;
}

/**
 * Convert per-frame detection results into a list of tracks.
 *
 * @param frameResults  Ordered per-frame detection results.
 * @param fps           Video frame rate (used for timestamp calculation).
 */
export function buildTracks(frameResults: FrameResult[], fps: number): Track[] {
  const active: ActiveTrack[] = [];
  const closed: ActiveTrack[] = [];

  for (const { frameIndex, timestamp, detections } of frameResults) {
    const assigned = new Set<ActiveTrack>();

    for (const detection of detections) {
      const match = findBestMatch(detection, active, frameIndex);

      if (match) {
        // Update the best-known plate text and region if this detection is better.
        if (match.plate === "" && detection.plate !== "") {
          match.plate = detection.plate;
        }
        if (detection.regionConfidence > match.regionConfidence) {
          match.region = detection.region;
          match.regionConfidence = detection.regionConfidence;
        }
        match.lastFrameIndex = frameIndex;
        match.entries.push({ frameIndex, timestamp, polygon: detection.polygon });
        assigned.add(match);
      } else {
        // New detection — start a new track.
        const newTrack: ActiveTrack = {
          plate: detection.plate,
          region: detection.region,
          regionConfidence: detection.regionConfidence,
          lastFrameIndex: frameIndex,
          entries: [{ frameIndex, timestamp, polygon: detection.polygon }],
        };
        active.push(newTrack);
        assigned.add(newTrack);
      }
    }

    // Close tracks that haven't been seen for too long.
    const stillActive: ActiveTrack[] = [];
    for (const track of active) {
      if (frameIndex - track.lastFrameIndex > MAX_GAP_FRAMES) {
        closed.push(track);
      } else {
        stillActive.push(track);
      }
    }
    active.splice(0, active.length, ...stillActive);
  }

  // Close any remaining active tracks.
  closed.push(...active);

  // Fill temporal gaps and convert to public Track type.
  return closed
    .filter((t) => t.entries.length > 0)
    .map((t) => {
      fillGaps(t, fps);
      return {
        plate: t.plate,
        region: t.region,
        history: t.entries.map((e) => ({
          frameIndex: e.frameIndex,
          timestamp: e.timestamp,
          polygon: e.polygon,
        })),
      };
    });
}
