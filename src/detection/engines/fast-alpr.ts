/**
 * ANPR engine backed by the fast-alpr Python library.
 *
 * A Python daemon process (scripts/detect-frame.py) is started once at
 * startup.  It loads the ONNX models and then waits for frame paths on stdin.
 * detectPlates() writes a path, reads a JSON line, and maps the result to
 * PlateDetection objects.  Region inference is performed locally using
 * src/regions/infer-region.ts because fast-alpr has no built-in classifier.
 *
 * Prerequisites (verified by check()):
 *  - python3 must be on PATH
 *  - The fast_alpr package must be importable (pip3 install fast-alpr)
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as readline from "readline";
import { DetectionEngine } from "../engine";
import { PlateDetection, Point } from "../../types";
import { inferRegion } from "../../regions/infer-region";

/** Raw plate entry returned by the Python daemon. */
interface DaemonPlate {
  ocr_text: string;
  confidence: number;
  bounding_box: { x1: number; y1: number; x2: number; y2: number };
}

/** A successful response line from the daemon. */
interface DaemonSuccess {
  plates: DaemonPlate[];
}

/** An error response line from the daemon. */
interface DaemonError {
  error: string;
}

/** Absolute path to the Python daemon script. */
const DAEMON_SCRIPT = path.resolve(__dirname, "../../../scripts/detect-frame.py");

/**
 * fast-alpr detection engine.
 *
 * Uses a single long-lived Python subprocess to avoid the 3–5 second ONNX
 * model load penalty that would occur on each per-frame invocation.
 */
export class FastAlprEngine implements DetectionEngine {
  private daemon: ChildProcess | null = null;
  private lines: readline.Interface | null = null;
  private pending: Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }> =
    new Map();

  /**
   * Verify python3 is on PATH and fast_alpr is importable.
   */
  async check(): Promise<void> {
    const pythonOk = await probe("python3", ["--version"]);
    if (!pythonOk) {
      throw new Error(
        "python3 not found.  Install Python 3 first:\n" +
          "  macOS: brew install python3\n" +
          "  Linux: sudo apt-get install python3"
      );
    }

    const importOk = await probe("python3", ["-c", "import fast_alpr"]);
    if (!importOk) {
      throw new Error(
        "fast_alpr Python package not found.\n" +
          "  Install it:  pip3 install fast-alpr"
      );
    }
  }

  /**
   * Spawn the Python daemon and wire up stdout line-by-line processing.
   */
  async startup(): Promise<void> {
    this.daemon = spawn("python3", [DAEMON_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.daemon.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[fast-alpr] ${chunk.toString()}`);
    });

    this.lines = readline.createInterface({ input: this.daemon.stdout! });

    this.lines.on("line", (line) => {
      // Each line maps to the oldest unresolved request (FIFO).
      const first = this.pending.keys().next().value;
      if (first !== undefined) {
        const handler = this.pending.get(first)!;
        this.pending.delete(first);
        handler.resolve(line);
      }
    });

    this.daemon.on("error", (err) => {
      for (const h of this.pending.values()) h.reject(err);
      this.pending.clear();
    });
  }

  /**
   * Send a frame path to the daemon and parse the JSON response.
   */
  async detectPlates(
    framePath: string,
    frameIndex: number,
    _regions: string[]
  ): Promise<PlateDetection[]> {
    if (!this.daemon || !this.lines) {
      throw new Error("fast-alpr daemon not started — call startup() first");
    }

    const responseLine = await this.sendRequest(framePath);
    const parsed = JSON.parse(responseLine) as DaemonSuccess | DaemonError;

    if ("error" in parsed) {
      throw new Error(`fast-alpr daemon error: ${parsed.error}`);
    }

    return parsed.plates.map((p) => mapPlate(p, frameIndex));
  }

  /**
   * Close the daemon's stdin so it exits cleanly.
   */
  async shutdown(): Promise<void> {
    try {
      this.daemon?.stdin?.end();
      this.lines?.close();
    } catch {
      // Ignore — the process may already be gone.
    }
    this.daemon = null;
    this.lines = null;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  /**
   * Write a frame path to stdin and return a promise that resolves with the
   * next response line from stdout.
   */
  private sendRequest(framePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const key = `${framePath}-${Date.now()}-${Math.random()}`;
      this.pending.set(key, { resolve, reject });
      this.daemon!.stdin!.write(`${framePath}\n`, (err) => {
        if (err) {
          this.pending.delete(key);
          reject(err);
        }
      });
    });
  }
}

// ── module-level helpers ───────────────────────────────────────────────────

/** Spawn a command and return true if it exits without error. */
function probe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Convert a fast-alpr bounding box (two corners) to a clockwise 4-point
 * polygon and infer the region from the plate text.
 */
function mapPlate(p: DaemonPlate, frameIndex: number): PlateDetection {
  const { x1, y1, x2, y2 } = p.bounding_box;
  const polygon: Point[] = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];

  const { region, regionConfidence } = inferRegion(p.ocr_text);

  return {
    plate: p.ocr_text ?? "",
    confidence: (p.confidence ?? 0) * 100,
    region,
    regionConfidence: regionConfidence * 100,
    polygon,
    frameIndex,
  };
}
