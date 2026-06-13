/**
 * Tesseract-based character scan to augment ANPR detection polygons.
 *
 * OpenALPR sometimes clips the left or right edge of a plate, missing one or
 * two characters. This pass expands each detection's polygon horizontally to
 * cover any alphanumeric characters that tesseract finds outside the ANPR bbox.
 *
 * The wider polygon is then used as the template for SAD visual tracking, so
 * all backward and forward coverage frames inherit the corrected width.
 */

import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { FrameInfo, FrameResult, Point } from "../types.js";

/** Minimum OCR confidence (0–100) to accept a word as evidence of a character. */
const CONFIDENCE_THRESHOLD = 40;

/** How far a word bbox must extend beyond the plate bbox (px) to trigger widening. */
const OVERHANG_PX = 5;

/**
 * Augment ANPR detection polygons by scanning a horizontally expanded crop of
 * each detection frame with tesseract. Any alphanumeric characters found outside
 * the ANPR polygon's left or right edge cause the polygon to be widened to
 * include them.
 *
 * Only frames with at least one ANPR detection are processed. The returned
 * array is a shallow copy of {@link frameResults} with modified polygon fields;
 * frames without detections are returned unchanged.
 *
 * @param frames        All extracted frames; used to locate frame image files.
 * @param frameResults  Per-frame ANPR detection results.
 * @param frameW        Frame pixel width (used to clamp the expanded crop).
 * @param frameH        Frame pixel height (used to clamp the expanded crop).
 */
export async function runCharacterScan(
  frames: FrameInfo[],
  frameResults: FrameResult[],
  frameW: number,
  frameH: number,
): Promise<FrameResult[]> {
  const detectionFrames = frameResults.filter((fr) => fr.detections.length > 0);
  if (detectionFrames.length === 0) return frameResults;

  const worker = await createWorker("eng");
  try {
    const augmented: FrameResult[] = frameResults.map((fr) => ({
      ...fr,
      detections: fr.detections.slice(),
    }));

    for (const fr of augmented) {
      if (fr.detections.length === 0) continue;
      const frame = frames[fr.frameIndex];
      if (!frame) continue;

      for (let di = 0; di < fr.detections.length; di++) {
        const det = fr.detections[di];
        const xs = det.polygon.map(([x]) => x);
        const ys = det.polygon.map(([, y]) => y);
        const plateBbox = {
          left: Math.min(...xs),
          top: Math.min(...ys),
          right: Math.max(...xs),
          bottom: Math.max(...ys),
        };

        const plateW = Math.max(1, plateBbox.right - plateBbox.left);
        const cropLeft = Math.max(0, Math.round(plateBbox.left - plateW * 0.5));
        const cropTop = Math.max(0, plateBbox.top);
        const cropRight = Math.min(frameW, Math.round(plateBbox.right + plateW * 0.5));
        const cropBottom = Math.min(frameH, plateBbox.bottom);
        const cropW = cropRight - cropLeft;
        const cropH = cropBottom - cropTop;
        if (cropW < 4 || cropH < 4) continue;

        const cropBuf = await sharp(frame.filePath)
          .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
          .jpeg({ quality: 95 })
          .toBuffer();

        const result = await worker.recognize(cropBuf);

        const words = (result.data.blocks ?? [])
          .flatMap((b) => b.paragraphs)
          .flatMap((p) => p.lines)
          .flatMap((l) => l.words)
          .filter((w) => w.confidence > CONFIDENCE_THRESHOLD)
          .filter((w) => w.text.replace(/[^a-zA-Z0-9]/g, "").length > 0);

        let unionLeft = plateBbox.left;
        let unionRight = plateBbox.right;

        for (const word of words) {
          const wordLeft = cropLeft + word.bbox.x0;
          const wordRight = cropLeft + word.bbox.x1;
          if (wordLeft < plateBbox.left - OVERHANG_PX || wordRight > plateBbox.right + OVERHANG_PX) {
            unionLeft = Math.min(unionLeft, wordLeft);
            unionRight = Math.max(unionRight, wordRight);
          }
        }

        if (unionLeft !== plateBbox.left || unionRight !== plateBbox.right) {
          const newPolygon: Point[] = [
            [unionLeft, plateBbox.top],
            [unionRight, plateBbox.top],
            [unionRight, plateBbox.bottom],
            [unionLeft, plateBbox.bottom],
          ];
          fr.detections[di] = { ...det, polygon: newPolygon };
        }
      }
    }

    return augmented;
  } finally {
    await worker.terminate();
  }
}
