/**
 * ANPR engine that runs OpenALPR inside a persistent Docker container.
 *
 * On startup a single container is launched with a Flask HTTP server.  Every
 * call to detectPlates() POSTs the JPEG bytes to that server and parses the
 * OpenALPR JSON response.  The container is stopped and removed on shutdown.
 *
 * Prerequisites (verified by check()):
 *  1. The `docker` CLI must be on PATH.
 *  2. The Docker daemon must be running.
 *  3. The `number-jam-alpr` image must exist (built via scripts/install-*.sh).
 */

import { spawn } from "child_process";
import { readFile } from "fs/promises";
import * as net from "net";
import * as path from "path";
import { DetectionEngine } from "../engine";
import { PlateDetection, Point } from "../../types";

/** Raw coordinate pair in the OpenALPR JSON output. */
interface RawCoordinate {
  x: number;
  y: number;
}

/** Raw per-plate entry in the OpenALPR JSON response. */
interface RawResult {
  plate: string;
  confidence: number;
  region: string;
  region_confidence: number;
  coordinates: RawCoordinate[];
}

/** Top-level structure of the OpenALPR JSON output. */
interface AlprOutput {
  results: RawResult[];
}

/** Milliseconds to wait between health-check polls on startup. */
const POLL_INTERVAL_MS = 300;
/** Maximum time to wait for the container's HTTP server to become ready. */
const STARTUP_TIMEOUT_MS = 30_000;

/**
 * Docker-backed OpenALPR detection engine.
 *
 * Keeps a single container alive for the duration of a run to avoid the
 * ~2 second startup cost that would otherwise apply per frame.
 */
export class DockerAlprEngine implements DetectionEngine {
  private containerName: string;
  private port: number = 0;
  private minConfidence: number;
  private rebuildImage: boolean;

  constructor(minConfidence = 0, rebuildImage = false) {
    this.containerName = `number-jam-alpr-${process.pid}`;
    this.minConfidence = minConfidence;
    this.rebuildImage = rebuildImage;
  }

  /**
   * Verify that Docker is installed and the daemon is running, then ensure
   * the number-jam-alpr image exists, building it if necessary.  Throws an
   * actionable error for each failure mode.
   */
  async check(): Promise<void> {
    await this.checkDockerCli();
    await this.checkDockerDaemon();
    await this.ensureImage();
  }

  /**
   * Allocate a free port, start the container, and wait until the HTTP server
   * inside it is accepting connections.
   */
  async startup(): Promise<void> {
    this.port = await findFreePort();

    await runCommand("docker", [
      "run",
      "-d",
      "-p",
      `${this.port}:8080`,
      "--name",
      this.containerName,
      "number-jam-alpr",
    ]);

    await this.waitForReady();
  }

  /**
   * Send a JPEG frame to the container and return all detected plates.
   *
   * @param framePath  Absolute path to the JPEG frame file.
   * @param frameIndex Zero-based frame index echoed into each result.
   * @param regions    Region filter; only the first non-"*" code is forwarded
   *                   to openalpr (multi-region filtering is done downstream).
   */
  async detectPlates(
    framePath: string,
    frameIndex: number,
    regions: string[]
  ): Promise<PlateDetection[]> {
    const jpegBytes = await readFile(framePath);

    const filteredRegions = regions.filter((r) => r !== "*");
    const regionParam = filteredRegions.length === 1 ? filteredRegions[0] : "";
    const params = new URLSearchParams();
    if (regionParam) params.set("region", regionParam);
    if (this.minConfidence > 0) params.set("min_confidence", String(this.minConfidence));
    const qs = params.toString();
    const url = `http://127.0.0.1:${this.port}/detect` + (qs ? `?${qs}` : "");

    const response = await fetch(url, {
      method: "POST",
      body: jpegBytes,
      headers: { "Content-Type": "image/jpeg" },
    });

    if (!response.ok) {
      throw new Error(
        `docker-alpr server returned HTTP ${response.status} for ${framePath}`
      );
    }

    const output = (await response.json()) as AlprOutput;

    return (output.results ?? []).map((r) => mapResult(r, frameIndex));
  }

  /**
   * Stop and remove the container.  Errors are swallowed so that a container
   * that failed to start does not cause a secondary exception in the finally block.
   */
  async shutdown(): Promise<void> {
    try {
      await runCommand("docker", ["stop", this.containerName]);
      await runCommand("docker", ["rm", this.containerName]);
    } catch {
      // Container may not exist if startup() never completed — ignore.
    }
  }

  // private helpers

  private async checkDockerCli(): Promise<void> {
    const ok = await probe("docker", ["--version"]);
    if (!ok) {
      const isLinux = process.platform === "linux";
      const hint = isLinux
        ? "  sudo apt-get install docker.io && sudo systemctl start docker"
        : "  brew install --cask docker-desktop";
      throw new Error(`docker CLI not found. Install Docker first:\n${hint}`);
    }
  }

  private async checkDockerDaemon(): Promise<void> {
    const ok = await probe("docker", ["info"]);
    if (!ok) {
      const isLinux = process.platform === "linux";
      const hint = isLinux
        ? "  sudo systemctl start docker"
        : "  Start Docker Desktop from your Applications folder.";
      throw new Error(`Docker daemon is not running.\n${hint}`);
    }
  }

  /**
   * Ensure the number-jam-alpr image is present, building it from the bundled
   * {@link docker/} directory if it is missing or if {@link rebuildImage} is set.
   *
   * `docker images -q` is more reliable on macOS Docker Desktop than
   * `docker image inspect`: it queries the image listing rather than resolving a
   * specific image manifest, which avoids spurious failures when the context
   * socket is being refreshed.
   */
  private async ensureImage(): Promise<void> {
    const id = await captureStdout("docker", ["images", "-q", "number-jam-alpr"]);
    const exists = !!id.trim();

    if (exists && !this.rebuildImage) return;

    const verb = exists ? "Rebuilding" : "Building";
    process.stderr.write(`${verb} number-jam-alpr Docker image (this may take a few minutes on first run)…\n`);
    await this.buildImage();
    process.stderr.write("Docker image built successfully.\n");
  }

  /** Build the number-jam-alpr image from the bundled docker/ directory. */
  private buildImage(): Promise<void> {
    // __dirname is dist/detection/engines/ at runtime; docker/ lives at the package root.
    const dockerDir = path.resolve(__dirname, "../../../docker");
    return new Promise((resolve, reject) => {
      const proc = spawn("docker", ["build", "-t", "number-jam-alpr", dockerDir], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      proc.on("error", (err) => reject(new Error(`docker error: ${err.message}`)));
      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error("docker build failed"));
        } else {
          resolve();
        }
      });
    });
  }

  /** Poll the container's health endpoint until it responds or we time out. */
  private async waitForReady(): Promise<void> {
    const url = `http://127.0.0.1:${this.port}/detect`;
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        await fetch(url, { method: "POST", body: Buffer.alloc(0) });
        return; // Any HTTP response means the server is up.
      } catch {
        await sleep(POLL_INTERVAL_MS);
      }
    }

    throw new Error(
      `docker-alpr container did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s`
    );
  }
}

// module-level helpers

/**
 * Spawn a command and return its stdout as a string.
 * Returns an empty string on any error; never throws.
 */
function captureStdout(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout?.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", () => resolve(""));
    proc.on("close", () => resolve(Buffer.concat(chunks).toString()));
  });
}

/**
 * Spawn a command and return true if it exits without error, false otherwise.
 * Never throws.
 */
function probe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Spawn a command, collect stderr, and reject with it if the process fails.
 */
function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr?.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", (err) => reject(new Error(`${cmd} error: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} exited ${code}: ${Buffer.concat(chunks)
              .toString()
              .trim()}`
          )
        );
      } else {
        resolve();
      }
    });
  });
}

/** Resolve with a free TCP port on 127.0.0.1. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

/** Map an OpenALPR raw result to a typed PlateDetection. */
function mapResult(raw: RawResult, frameIndex: number): PlateDetection {
  const polygon: Point[] = (raw.coordinates ?? []).map((c) => [c.x, c.y]);
  return {
    plate: raw.plate ?? "",
    confidence: raw.confidence ?? 0,
    region: raw.region || null,
    regionConfidence: raw.region_confidence ?? 0,
    polygon,
    frameIndex,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
