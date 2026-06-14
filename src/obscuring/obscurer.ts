/**
 * Obscures number plate polygons by filling them with the plate's estimated
 * background colour and soft-feathered edges.
 *
 * Strategy per plate:
 *  1. Compute the axis-aligned bounding box from the polygon vertices.
 *  2. If the box is degenerate (< 4px), skip.
 *  3. Read the raw pixels from the bounding box region.
 *  4. Estimate the background colour: pixels brighter than the mean luma are
 *     background candidates (plate surface); darker pixels are text strokes.
 *     Average those bright pixels to get the fill colour.
 *  5. Render a greyscale alpha mask (white polygon on black) and apply a
 *     Gaussian blur to feather the polygon edges.
 *  6. Attach the blurred mask as the alpha channel of a solid-colour image.
 *     Doing this separately (rather than blurring the RGBA overlay directly)
 *     prevents the colour-bleed artefact where sharp blurs the transparent
 *     black exterior into the fill colour at the edge.
 *  7. Composite the feathered overlay onto the frame.
 *
 * The result is written to outputPath.
 */

import sharp from "sharp";
import { PlateDetection, PaddingSpec, Point } from "../types";

/** Options controlling how a single frame is obscured. */
export interface ObscureFrameOptions {
  /**
   * Alpha multiplier (0–1) applied uniformly to every polygon overlay in this
   * frame. Used by the fade-in / fade-out extension. Defaults to 1 (fully
   * opaque).
   */
  fadeAlpha?: number;
  /** Horizontal expansion applied to each polygon on each side before masking. */
  paddingW?: PaddingSpec;
  /** Vertical expansion applied to each polygon on each side before masking. */
  paddingH?: PaddingSpec;
}

/**
 * Obscure the plate polygons in a single frame image and write the result.
 *
 * @param framePath   Source JPEG frame.
 * @param detections  Plate detections to obscure within this frame.
 * @param outputPath  Destination file path for the modified frame.
 * @param options     Optional rendering controls (fade alpha, padding).
 */
export async function obscureFrame(
  framePath: string,
  detections: PlateDetection[],
  outputPath: string,
  options: ObscureFrameOptions = {},
): Promise<void> {
  if (detections.length === 0) {
    await sharp(framePath).toFile(outputPath);
    return;
  }

  const { width: frameW, height: frameH } = await sharp(framePath).metadata();
  if (!frameW || !frameH) throw new Error(`Cannot read dimensions from ${framePath}`);

  const overlays: sharp.OverlayOptions[] = [];

  for (const detection of detections) {
    if (detection.polygon.length < 3) continue;
    const overlay = await buildPolygonOverlay(framePath, detection.polygon, frameW, frameH, options);
    if (overlay) overlays.push(overlay);
  }

  if (overlays.length === 0) {
    await sharp(framePath).toFile(outputPath);
    return;
  }

  await sharp(framePath).composite(overlays).toFile(outputPath);
}

/**
 * Compute the tilt angle (degrees) of a plate polygon from the horizontal axis.
 * Exported for unit testing.
 */
export function plateAngleDeg(polygon: Point[]): number {
  const [x0, y0] = polygon[0];
  const [x1, y1] = polygon[1];
  return (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
}

/**
 * Return the axis-aligned bounding box of a polygon, clamped to frame bounds.
 * Exported for unit testing.
 */
export function clampedBbox(
  polygon: Point[],
  frameW: number,
  frameH: number
): { left: number; top: number; width: number; height: number } {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const right = Math.min(frameW, Math.ceil(Math.max(...xs)));
  const bottom = Math.min(frameH, Math.ceil(Math.max(...ys)));
  return { left, top, width: right - left, height: bottom - top };
}

// Gaussian sigma for polygon edge feathering; roughly 2× this value in pixels
// of soft transition on each side of the polygon boundary.
const EDGE_BLUR_SIGMA = 3;

/**
 * When the polygon's top edge is within this many pixels of y = 0 (or the
 * bottom/left/right frame edge), shift all vertices so the nearest edge of
 * the polygon touches the frame boundary. This eliminates the thin wedge of
 * visible plate caused by the ANPR detection polygon's upper-left corner
 * sitting a few pixels below y = 0 while the upper-right corner is already
 * at y = 0.
 *
 * Applied only to the SVG mask vertices — colour sampling still uses the
 * original bounding box so the fill estimate is unaffected.
 */
const EDGE_SNAP_MARGIN = 20;

/**
 * Shift the polygon vertically / horizontally so that any edge that is within
 * EDGE_SNAP_MARGIN px of a frame boundary is moved flush with that boundary.
 * Handles top and bottom edges; left and right follow the same pattern if
 * needed in future. Exported for unit testing.
 */
export function snapPolygonToEdges(polygon: Point[], frameW: number, frameH: number): Point[] {
  const ys = polygon.map(([, y]) => y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  // Snap top: shift up when the top edge is inside the frame but within margin.
  let dy = 0;
  if (minY > 0 && minY < EDGE_SNAP_MARGIN) dy = -minY;
  // Snap bottom: shift down when the bottom edge is within margin of frameH.
  else if (maxY < frameH && maxY > frameH - EDGE_SNAP_MARGIN) dy = frameH - maxY;

  if (dy === 0) return polygon;
  return polygon.map(([x, y]) => [x, y + dy] as Point);
}

/**
 * Expand a polygon outward symmetrically to cover additional area on each
 * side. The expanded region is axis-aligned and centred on the original
 * polygon's centre point. Clamped to the frame bounds.
 *
 * @param polygon   Original polygon vertices.
 * @param paddingW  Optional horizontal padding spec (applied to each side).
 * @param paddingH  Optional vertical padding spec (applied to each side).
 * @param frameW    Frame pixel width used for clamping and `%` resolution.
 * @param frameH    Frame pixel height used for clamping and `%` resolution.
 */
export function expandPolygon(
  polygon: Point[],
  paddingW: PaddingSpec | undefined,
  paddingH: PaddingSpec | undefined,
  frameW: number,
  frameH: number,
): Point[] {
  if (!paddingW && !paddingH) return polygon;

  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  const origW = Math.max(...xs) - Math.min(...xs);
  const origH = Math.max(...ys) - Math.min(...ys);

  const pw = paddingW
    ? (paddingW.unit === "%" ? (paddingW.value / 100) * origW : paddingW.value)
    : 0;
  const ph = paddingH
    ? (paddingH.unit === "%" ? (paddingH.value / 100) * origH : paddingH.value)
    : 0;

  const left   = Math.max(0,      Math.min(...xs) - pw);
  const right  = Math.min(frameW, Math.max(...xs) + pw);
  const top    = Math.max(0,      Math.min(...ys) - ph);
  const bottom = Math.min(frameH, Math.max(...ys) + ph);

  return [[left, top], [right, top], [right, bottom], [left, bottom]] as Point[];
}

/**
 * Build a sharp OverlayOptions that fills the plate polygon with the
 * estimated background colour and soft-feathered edges.
 *
 * Reads raw pixels from the bounding box, computes the mean luma, then
 * averages only the pixels brighter than that mean. On a standard plate
 * (dark text on a light surface) those bright pixels are the background.
 * The alpha mask is blurred separately so the fill colour stays constant
 * at the edges rather than bleeding towards black.
 * Returns null when the polygon's bounding box is degenerate (< 4 px).
 */
async function buildPolygonOverlay(
  framePath: string,
  polygon: Point[],
  frameW: number,
  frameH: number,
  options: ObscureFrameOptions = {},
): Promise<sharp.OverlayOptions | null> {
  const expanded = expandPolygon(polygon, options.paddingW, options.paddingH, frameW, frameH);
  const box = clampedBbox(expanded, frameW, frameH);
  if (box.width < 4 || box.height < 4) return null;

  const { data, info } = await sharp(framePath)
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Two-pass luma split: compute mean brightness across all pixels, then
  // average only the pixels that exceed it. For a plate with dark text on a
  // light background those bright pixels are the plate surface, giving a
  // clean background colour estimate.
  const n = info.width * info.height;
  const ch = info.channels;
  let totalLuma = 0;
  for (let i = 0; i < data.length; i += ch) {
    totalLuma += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  }
  const meanLuma = totalLuma / n;

  let rSum = 0, gSum = 0, bSum = 0, bgCount = 0;
  for (let i = 0; i < data.length; i += ch) {
    const luma = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    if (luma > meanLuma) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
      bgCount++;
    }
  }

  const r = bgCount > 0 ? Math.round(rSum / bgCount) : 220;
  const g = bgCount > 0 ? Math.round(gSum / bgCount) : 220;
  const b = bgCount > 0 ? Math.round(bSum / bgCount) : 220;

  // The SVG mask uses the edge-snapped expanded polygon so the obscured region
  // starts flush with the frame boundary when the plate is near an edge.
  const snapped = snapPolygonToEdges(expanded, frameW, frameH);
  const pts = snapped.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(" ");

  // Greyscale alpha mask: white polygon on opaque black background so that
  // sharp renders a 3-channel (no-alpha) image. After greyscale conversion
  // and blur, the result is a single-channel buffer where 255 = fully opaque
  // and the edges fade to 0. This is joined as the alpha channel of a
  // solid-colour image rather than blurring the RGBA overlay directly,
  // which would cause the fill colour to bleed towards black at the edges.
  const maskSvg = `<svg width="${frameW}" height="${frameH}" xmlns="http://www.w3.org/2000/svg"><rect width="${frameW}" height="${frameH}" fill="black"/><polygon points="${pts}" fill="white"/></svg>`;
  const rawMask = await sharp(Buffer.from(maskSvg))
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .greyscale()
    .blur(EDGE_BLUR_SIGMA)
    .raw()
    .toBuffer();

  // Apply fade alpha by scaling every mask pixel. Skip allocation when fully opaque.
  const fadeAlpha = options.fadeAlpha ?? 1;
  const blurredMask = fadeAlpha < 1
    ? Buffer.from(rawMask.map((v) => Math.round(v * fadeAlpha)))
    : rawMask;

  const overlay = await sharp({
    create: { width: frameW, height: frameH, channels: 3, background: { r, g, b } },
  })
    .joinChannel(blurredMask, { raw: { width: frameW, height: frameH, channels: 1 } })
    .png()
    .toBuffer();

  return { input: overlay, top: 0, left: 0 };
}
