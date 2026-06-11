"""
HTTP wrapper around the openalpr CLI for use inside the number-jam Docker image.

Accepts POST requests with a raw JPEG body.  An optional `region` query
parameter maps to openalpr's -c flag.  An optional `min_confidence` query
parameter (0–100, default 0) drops any result whose OCR confidence is below
that value.  Returns the JSON object that openalpr writes to stdout when given
the -j flag.

Endpoint: POST /detect?region=<iso-code>&min_confidence=<number>
"""

import json
import os
import subprocess
import tempfile

from flask import Flask, request, jsonify

app = Flask(__name__)


@app.route("/detect", methods=["POST"])
def detect():
    """
    Receive a JPEG image body, run openalpr on it, and return the parsed JSON.
    Returns an empty results list when no plates are found.
    """
    region = request.args.get("region", "").strip()
    try:
        min_confidence = float(request.args.get("min_confidence", "0"))
    except ValueError:
        min_confidence = 0.0

    jpeg_bytes = request.get_data()
    if not jpeg_bytes:
        return jsonify({"error": "empty body"}), 400

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(jpeg_bytes)
        tmp_path = tmp.name

    try:
        args = ["alpr", "-j"]
        if region:
            args += ["-c", region]
        args.append(tmp_path)

        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        raw = result.stdout.decode("utf-8", errors="replace").strip()
        if not raw:
            return jsonify({"version": 0, "data_type": "alpr_results", "results": []})

        parsed = json.loads(raw)

        if min_confidence > 0:
            parsed["results"] = [
                r for r in parsed.get("results", [])
                if r.get("confidence", 0) >= min_confidence
            ]

        return app.response_class(
            response=json.dumps(parsed),
            status=200,
            mimetype="application/json",
        )
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
