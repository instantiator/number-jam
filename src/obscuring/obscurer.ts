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
import { PlateDetection, Point } from "../types";

/**
 * Obscure the plate polygons in a single frame image and write the result.
 *
 * @param framePath   Source JPEG frame.
 * @param detections  Plate detections to obscure within this frame.
 * @param outputPath  Destination file path for the modified frame.
 */
export async function obscureFrame(
  framePath: string,
  detections: PlateDetection[],
  outputPath: string
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
    const overlay = await buildPolygonOverlay(framePath, detection.polygon, frameW, frameH);
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
  frameH: number
): Promise<sharp.OverlayOptions | null> {
  const box = clampedBbox(polygon, frameW, frameH);
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

  const pts = polygon.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(" ");

  // Greyscale alpha mask: white polygon on opaque black background so that
  // sharp renders a 3-channel (no-alpha) image. After greyscale conversion
  // and blur, the result is a single-channel buffer where 255 = fully opaque
  // and the edges fade to 0. This is joined as the alpha channel of a
  // solid-colour image rather than blurring the RGBA overlay directly,
  // which would cause the fill colour to bleed towards black at the edges.
  const maskSvg = `<svg width="${frameW}" height="${frameH}" xmlns="http://www.w3.org/2000/svg"><rect width="${frameW}" height="${frameH}" fill="black"/><polygon points="${pts}" fill="white"/></svg>`;
  const blurredMask = await sharp(Buffer.from(maskSvg))
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .greyscale()
    .blur(EDGE_BLUR_SIGMA)
    .raw()
    .toBuffer();

  const overlay = await sharp({
    create: { width: frameW, height: frameH, channels: 3, background: { r, g, b } },
  })
    .joinChannel(blurredMask, { raw: { width: frameW, height: frameH, channels: 1 } })
    .png()
    .toBuffer();

  return { input: overlay, top: 0, left: 0 };
}
