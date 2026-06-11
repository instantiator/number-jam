/**
 * Fills number plate polygons with solid black within a frame image.
 *
 * Strategy per plate:
 *  1. Compute the axis-aligned bounding box from the polygon vertices.
 *  2. If the box is degenerate (< 4px), skip.
 *  3. Generate a full-frame SVG with the polygon filled black.
 *  4. Composite the SVG overlay onto the frame using the "over" blend mode.
 *
 * Using a polygon fill (rather than an axis-aligned rectangle) respects the
 * plate's actual orientation and shape, giving a tighter mask.
 *
 * The result is written to outputPath.
 */

import sharp from "sharp";
import { PlateDetection, Point } from "../types";

/**
 * Fill the plate polygons in a single frame image and write the result.
 *
 * @param framePath   Source JPEG frame.
 * @param detections  Plate detections to obscure within this frame.
 * @param outputPath  Destination file path for the modified frame.
 */
export async function pixelateFrame(
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
    const overlay = buildPolygonOverlay(detection.polygon, frameW, frameH);
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

/**
 * Build a sharp OverlayOptions that fills the plate polygon with solid black.
 *
 * Generates a full-frame SVG with the polygon drawn in black. The transparent
 * background outside the polygon means only the plate region is obscured.
 * Returns null when the polygon's bounding box is degenerate (< 4 px).
 */
function buildPolygonOverlay(
  polygon: Point[],
  frameW: number,
  frameH: number
): sharp.OverlayOptions | null {
  const box = clampedBbox(polygon, frameW, frameH);
  if (box.width < 4 || box.height < 4) return null;

  const pts = polygon.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(" ");
  const svg = `<svg width="${frameW}" height="${frameH}" xmlns="http://www.w3.org/2000/svg"><polygon points="${pts}" fill="black"/></svg>`;

  return { input: Buffer.from(svg), top: 0, left: 0 };
}
