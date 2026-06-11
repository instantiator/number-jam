"""
Persistent fast-alpr daemon used by the fast-alpr detection engine.

The process starts once, imports fast-alpr (which loads ONNX models), then
enters a stdin loop.  Each line read from stdin is a path to a JPEG frame;
one line of JSON is written to stdout in response.  The process exits when
stdin is closed.

Output JSON shape (one object per line):
  {
    "plates": [
      {
        "ocr_text": "AB12CDE",
        "confidence": 0.94,
        "bounding_box": { "x1": 100, "y1": 200, "x2": 300, "y2": 260 }
      }
    ]
  }

Errors are written as:
  { "error": "<message>" }
"""

import json
import sys

from fast_alpr import ALPR


def main() -> None:
    """
    Import fast-alpr once, then process frame paths from stdin until EOF.
    Flushing after every write keeps the TypeScript side from blocking on
    a partially-filled OS pipe buffer.
    """
    alpr = ALPR()

    for raw_line in sys.stdin:
        frame_path = raw_line.rstrip("\n")
        if not frame_path:
            continue

        try:
            results = alpr.run(frame_path)
            plates = []
            for r in results:
                if r.ocr is None:
                    continue
                plate = r.ocr
                bbox = r.detection.bounding_box
                plates.append({
                    "ocr_text": plate.ocr_text,
                    "confidence": plate.confidence,
                    "bounding_box": {
                        "x1": int(bbox.x1),
                        "y1": int(bbox.y1),
                        "x2": int(bbox.x2),
                        "y2": int(bbox.y2),
                    },
                })
            print(json.dumps({"plates": plates}), flush=True)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
