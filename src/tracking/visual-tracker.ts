/**
 * Visual object tracker using SAD (Sum of Absolute Differences) template matching.
 *
 * Tracks a plate polygon backwards or forwards from a track endpoint, frame-by-frame,
 * until the match score exceeds a confidence threshold or the polygon fully leaves
 * the frame. Tracking is unconstrained in time; it continues as long as the plate
 * remains identifiable, including when it is partially outside the frame.
 *
 * Uses sharp for image I/O only — pure TypeScript SAD, no WASM.
 *
 * Returns an empty array when tracking fails; callers should fall back to
 * velocity extrapolation in that case.
 */

import sharp from "sharp";
import { FrameInfo, Track, TrackHistoryEntry, Point } from "../types.js";
import { shiftPolygon } from "./motion.js";
import { clampedBbox } from "../obscuring/obscurer.js";

/** pixels around last known bbox to expand the search window */
const SEARCH_MARGIN = 40;
/** reduce frame region size before computing SAD */
const DOWNSAMPLE = 4;
/** max normalised SAD to accept (0=perfect, 1=worst) */
const MATCH_THRESHOLD = 0.22;
/** min downsampled template dimension; too small = unreliable */
const MIN_TEMPLATE_PX = 4;
/**
 * Additional SAD tolerance added when the plate is partially outside the frame.
 * Partial plates naturally produce higher SAD scores, so without this boost
 * they would be rejected too early during entry or exit.
 */
const EDGE_THRESHOLD_BOOST = 0.15;
/** Re-sample the tracking template from the current frame every N frames. */
const TEMPLATE_UPDATE_INTERVAL = 5;
/**
 * Safety cap on unconstrained tracking (≈ 10 min at 30 fps). Prevents runaway
 * loops on malformed input; in practice the confidence threshold drops first.
 */
const MAX_EXTENSION_FRAMES = 18_000;
/** Frames to look back when checking whether the tracker has stalled. */
const STALL_WINDOW = 5;
/**
 * If the polygon centroid has moved less than this many pixels over the last
 * STALL_WINDOW frames AND the polygon is near a frame edge AND the average
 * match score is above SCORE_THRESHOLD, the tracker has frozen against static
 * background content rather than following the plate.
 *
 * The score condition is critical: a slowly-entering plate also produces
 * < STALL_PX drift per window but has a low (good) score — it must not be
 * stopped. Only a high score (poor match = background latching) triggers stop.
 */
const STALL_PX = 2;
/**
 * Average SAD score over the last STALL_WINDOW frames above which the tracker
 * is considered to be latched onto background rather than the plate.
 * A real plate typically scores 0.05–0.10; background content 0.13–0.20.
 */
const SCORE_THRESHOLD = 0.12;

/**
 * Minimum fraction of the polygon's bounding box that must be visible within
 * the frame for tracking to continue. Below this threshold the template match
 * is unreliable (there is almost no plate signal), and any polygon produced
 * would clip to a strip too thin to obscure meaningful content.
 *
 * Exported so callers can pass the same value to velocity-extrapolation
 * filters, ensuring consistent behaviour across both mechanisms.
 */
export const MIN_VISIBLE_FRACTION = 0.01;

/** A single frame entry produced by the visual tracker. */
export interface TrackedFrame {
  frameIndex: number;
  polygon: Point[];
}

/**
 * Track the plate polygon backwards from the first history entry.
 * Runs until match confidence drops, the polygon is less than
 * {@link minVisibleFraction} visible, or it fully leaves the frame.
 *
 * @param frames              All extracted frames (used to map frameIndex → file path).
 * @param track               The track whose starting endpoint is used as the anchor.
 * @param minVisibleFraction  Stop tracking when this fraction of the polygon is outside
 *                            the frame (default: {@link MIN_VISIBLE_FRACTION}).
 * @returns                   Tracked frames in descending frameIndex order, or an empty
 *                            array when the template is too small or the match fails immediately.
 */
export async function trackBack(
  frames: FrameInfo[],
  track: Track,
  minVisibleFraction = MIN_VISIBLE_FRACTION,
): Promise<TrackedFrame[]> {
  const first = track.history[0];
  if (!first) return [];
  return trackSegment(
    frames,
    first.polygon,
    first.frameIndex,
    "back",
    Math.max(0, first.frameIndex - MAX_EXTENSION_FRAMES),
    minVisibleFraction,
  );
}

/**
 * Track the plate polygon forwards from the last history entry.
 * Runs until match confidence drops, the polygon is less than
 * {@link minVisibleFraction} visible, or it fully leaves the frame.
 *
 * @param frames              All extracted frames.
 * @param track               The track whose exit endpoint is used as the anchor.
 * @param minVisibleFraction  Stop tracking when this fraction of the polygon is outside
 *                            the frame (default: {@link MIN_VISIBLE_FRACTION}).
 * @returns                   Tracked frames in ascending frameIndex order, or an empty array.
 */
export async function trackForward(
  frames: FrameInfo[],
  track: Track,
  minVisibleFraction = MIN_VISIBLE_FRACTION,
): Promise<TrackedFrame[]> {
  const last = track.history[track.history.length - 1];
  if (!last) return [];
  const lastFi = frames.length > 0 ? frames[frames.length - 1].frameIndex : 0;
  return trackSegment(
    frames,
    last.polygon,
    last.frameIndex,
    "forward",
    Math.min(lastFi, last.frameIndex + MAX_EXTENSION_FRAMES),
    minVisibleFraction,
  );
}

/**
 * Fill the gap between two adjacent track history entries using SAD template
 * matching. Tracks forward from {@link fromEntry} toward {@link toEntry},
 * stopping when confidence drops before the gap is fully bridged.
 *
 * @param frames              All extracted frames.
 * @param fromEntry           Earlier history entry (provides the anchor template).
 * @param toEntry             Later history entry (exclusive stop frame).
 * @param minVisibleFraction  Stop tracking when this fraction of the polygon is outside
 *                            the frame (default: {@link MIN_VISIBLE_FRACTION}).
 * @returns                   Tracked frames in ascending frameIndex order.
 */
export async function trackGap(
  frames: FrameInfo[],
  fromEntry: TrackHistoryEntry,
  toEntry: TrackHistoryEntry,
  minVisibleFraction = MIN_VISIBLE_FRACTION,
): Promise<TrackedFrame[]> {
  if (toEntry.frameIndex - fromEntry.frameIndex <= 1) return [];
  return trackSegment(
    frames,
    fromEntry.polygon,
    fromEntry.frameIndex,
    "forward",
    toEntry.frameIndex - 1,
    minVisibleFraction,
  );
}

// Unclamped axis-aligned bounding box for a polygon.
function rawBbox(polygon: Point[]): { left: number; top: number; width: number; height: number } {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  const left = Math.floor(Math.min(...xs));
  const top = Math.floor(Math.min(...ys));
  return {
    left,
    top,
    width: Math.ceil(Math.max(...xs)) - left,
    height: Math.ceil(Math.max(...ys)) - top,
  };
}

// Centroid of a polygon (average of all vertices).
function centroid(polygon: Point[]): [number, number] {
  return [
    polygon.reduce((s, [x]) => s + x, 0) / polygon.length,
    polygon.reduce((s, [, y]) => s + y, 0) / polygon.length,
  ];
}

// Fraction of the polygon's bounding box that is visible within the frame.
// Returns 1 when fully inside, approaching 0 as the polygon moves off-screen.
function visibleFraction(polygon: Point[], frameW: number, frameH: number): number {
  const b = rawBbox(polygon);
  const visLeft = Math.max(0, b.left);
  const visTop = Math.max(0, b.top);
  const visRight = Math.min(frameW, b.left + b.width);
  const visBottom = Math.min(frameH, b.top + b.height);
  if (visRight <= visLeft || visBottom <= visTop) return 0;
  const visible = (visRight - visLeft) * (visBottom - visTop);
  const total = b.width * b.height;
  return total > 0 ? visible / total : 0;
}

// Extract a greyscale region from a JPEG, downsampled by `factor`.
async function extractGrey(
  filePath: string,
  left: number,
  top: number,
  width: number,
  height: number,
  factor: number,
): Promise<{ data: Buffer; w: number; h: number }> {
  const w = Math.max(1, Math.ceil(width / factor));
  const h = Math.max(1, Math.ceil(height / factor));
  const { data } = await sharp(filePath)
    .extract({ left, top, width, height })
    .greyscale()
    .resize(w, h, { kernel: "nearest" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w, h };
}

// Exhaustive SAD between a template and all positions in a search region.
// Returns the offset (dx, dy) of the best match in downsampled coordinates and
// the normalised score (0=perfect, 1=worst).
function bestMatch(
  template: Buffer,
  tW: number,
  tH: number,
  search: Buffer,
  sW: number,
  sH: number,
): { dx: number; dy: number; score: number } {
  let bestDx = 0;
  let bestDy = 0;
  let bestSad = Infinity;

  for (let dy = 0; dy <= sH - tH; dy++) {
    for (let dx = 0; dx <= sW - tW; dx++) {
      let sad = 0;
      for (let ty = 0; ty < tH; ty++) {
        for (let tx = 0; tx < tW; tx++) {
          sad += Math.abs(template[ty * tW + tx] - search[(dy + ty) * sW + (dx + tx)]);
        }
      }
      if (sad < bestSad) {
        bestSad = sad;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  return { dx: bestDx, dy: bestDy, score: bestSad / (tW * tH * 255) };
}

/**
 * Core tracking loop shared by {@link trackBack}, {@link trackForward}, and
 * {@link trackGap}.
 *
 * Advances one frame at a time in the given direction, stopping when:
 * - the polygon's visible fraction drops below {@link minVisibleFraction},
 * - the match score exceeds the adaptive threshold, or
 * - the polygon fully exits the frame.
 *
 * The template is periodically refreshed from the current matched region to
 * adapt to gradual changes in lighting and plate angle.
 */
async function trackSegment(
  frames: FrameInfo[],
  anchorPolygon: Point[],
  anchorFrameIndex: number,
  direction: "back" | "forward",
  limitFrameIndex: number,
  minVisibleFraction: number,
): Promise<TrackedFrame[]> {
  const isBack = direction === "back";
  const frameMap = new Map(frames.map((f) => [f.frameIndex, f]));
  const anchorFrame = frameMap.get(anchorFrameIndex);
  if (!anchorFrame) return [];

  const meta = await sharp(anchorFrame.filePath).metadata();
  const frameW = meta.width;
  const frameH = meta.height;
  if (!frameW || !frameH) return [];

  const anchorBbox = clampedBbox(anchorPolygon, frameW, frameH);
  if (anchorBbox.width < 4 || anchorBbox.height < 4) return [];

  let { data: templateData, w: tW, h: tH } = await extractGrey(
    anchorFrame.filePath,
    anchorBbox.left,
    anchorBbox.top,
    anchorBbox.width,
    anchorBbox.height,
    DOWNSAMPLE,
  );
  if (tW < MIN_TEMPLATE_PX || tH < MIN_TEMPLATE_PX) return [];

  let polygon = anchorPolygon;
  const results: TrackedFrame[] = [];
  const step = isBack ? -1 : 1;
  let framesSinceUpdate = 0;
  const recentScores: number[] = [];

  for (
    let fi = anchorFrameIndex + step;
    isBack ? fi >= limitFrameIndex : fi <= limitFrameIndex;
    fi += step
  ) {
    const frameInfo = frameMap.get(fi);
    if (!frameInfo) continue;

    // Stop early when the polygon has nearly left the frame; the template is
    // unreliable at this point and any match would obscure an invisible sliver.
    const vis = visibleFraction(polygon, frameW, frameH);
    if (vis < minVisibleFraction) break;

    // Use the unclamped bbox to correctly center the search window even when
    // the polygon has partially moved off-screen.
    const pBbox = rawBbox(polygon);
    const searchLeft = Math.max(0, pBbox.left - SEARCH_MARGIN);
    const searchTop = Math.max(0, pBbox.top - SEARCH_MARGIN);
    const searchRight = Math.min(frameW, pBbox.left + pBbox.width + SEARCH_MARGIN);
    const searchBottom = Math.min(frameH, pBbox.top + pBbox.height + SEARCH_MARGIN);
    const searchW = searchRight - searchLeft;
    const searchH = searchBottom - searchTop;

    if (searchW < 4 || searchH < 4) break;

    const { data: searchData, w: sW, h: sH } = await extractGrey(
      frameInfo.filePath,
      searchLeft,
      searchTop,
      searchW,
      searchH,
      DOWNSAMPLE,
    );

    // The search window (downsampled) must be at least as large as the template.
    // If it's smaller the plate is too close to the frame edge — stop here and
    // let velocity extrapolation cover the remaining frames.
    if (sW < tW || sH < tH) break;

    const { dx, dy, score } = bestMatch(templateData, tW, tH, searchData, sW, sH);

    // Relax the threshold proportionally to how much of the polygon has moved
    // off-screen: a partially visible plate naturally produces a higher SAD score.
    const effectiveThreshold = MATCH_THRESHOLD + (1 - vis) * EDGE_THRESHOLD_BOOST;
    if (score > effectiveThreshold) break;

    // Convert the downsampled match offset to a full-resolution polygon shift.
    const matchLeft = searchLeft + dx * DOWNSAMPLE;
    const matchTop = searchTop + dy * DOWNSAMPLE;
    polygon = shiftPolygon(polygon, matchLeft - pBbox.left, matchTop - pBbox.top);

    const newClamped = clampedBbox(polygon, frameW, frameH);
    if (newClamped.width < 4 || newClamped.height < 4) break;

    results.push({ frameIndex: fi, polygon });

    recentScores.push(score);
    if (recentScores.length > STALL_WINDOW) recentScores.shift();

    // Periodically refresh the template from the current best-match region to
    // adapt to gradual changes in lighting and plate angle.
    framesSinceUpdate++;
    if (framesSinceUpdate >= TEMPLATE_UPDATE_INTERVAL) {
      const newBbox = clampedBbox(polygon, frameW, frameH);
      if (newBbox.width >= 4 && newBbox.height >= 4) {
        const updated = await extractGrey(
          frameInfo.filePath,
          newBbox.left,
          newBbox.top,
          newBbox.width,
          newBbox.height,
          DOWNSAMPLE,
        );
        if (updated.w >= MIN_TEMPLATE_PX && updated.h >= MIN_TEMPLATE_PX) {
          templateData = updated.data;
          tW = updated.w;
          tH = updated.h;
        }
      }
      framesSinceUpdate = 0;
    }

    // Stall detection: stop when the polygon is near a frame edge, has barely
    // moved over the last STALL_WINDOW frames, AND the average match score is
    // poor (background latching). The score guard is essential: a plate that
    // enters the frame very slowly also has low centroid drift but produces a
    // genuinely good (low) match score and must not be stopped.
    if (results.length >= STALL_WINDOW && recentScores.length >= STALL_WINDOW) {
      const ref = results[results.length - STALL_WINDOW];
      const [rcx, rcy] = centroid(ref.polygon);
      const [ccx, ccy] = centroid(polygon);
      const drift = Math.hypot(ccx - rcx, ccy - rcy);
      const avgScore = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;
      const b = rawBbox(polygon);
      const nearEdge =
        b.top < SEARCH_MARGIN ||
        b.top + b.height > frameH - SEARCH_MARGIN ||
        b.left < SEARCH_MARGIN ||
        b.left + b.width > frameW - SEARCH_MARGIN;
      if (nearEdge && drift < STALL_PX && avgScore > SCORE_THRESHOLD) break;
    }
  }

  return results;
}
