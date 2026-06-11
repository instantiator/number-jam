/**
 * Downloads test fixture files into tests/fixtures/.
 *
 * This script is idempotent: files that already exist are skipped.
 * Run it with: npm run download-fixtures
 *
 * Fixture licence details are in tests/fixtures/ATTRIBUTION.md.
 */

import { createWriteStream, existsSync, mkdirSync } from "fs";
import * as https from "https";
import * as http from "http";
import * as path from "path";
import { pipeline } from "stream/promises";

const FIXTURES_DIR = path.resolve(__dirname, "../tests/fixtures");

/** Each fixture: destination filename and source URL. */
const FIXTURES: Array<{ name: string; url: string }> = [
  {
    name: "bbb-10s.mp4",
    url: "https://archive.org/download/big-buck-bunny-1080-10s-1-mb/Big_Buck_Bunny_1080_10s_1MB.mp4",
  },
  {
    name: "plate-ca.jpg",
    url: "https://upload.wikimedia.org/wikipedia/commons/9/94/Californian_2024_license_plate.jpg",
  },
  {
    name: "plate-rs.jpg",
    url: "https://upload.wikimedia.org/wikipedia/commons/9/96/Temporary_license_plate_from_Priboj%2C_Serbia._2012._FAP_truck_5.JPG",
  },
];

async function main(): Promise<void> {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  for (const fixture of FIXTURES) {
    const dest = path.join(FIXTURES_DIR, fixture.name);

    if (existsSync(dest)) {
      console.log(`  already exists: ${fixture.name}`);
      continue;
    }

    console.log(`  downloading: ${fixture.name} …`);
    await download(fixture.url, dest);
    console.log(`  saved: ${fixture.name}`);
  }

  console.log("Done.");
}

const REQUEST_HEADERS = {
  "User-Agent": "number-jam-test-fixture-downloader/1.0 (https://github.com/number-jam)",
};

/**
 * Download a URL (following redirects) and save it to a file.
 */
async function download(url: string, dest: string): Promise<void> {
  const resolved = await resolveRedirects(url);

  await new Promise<void>((resolve, reject) => {
    const protocol = resolved.startsWith("https") ? https : http;
    const req = protocol.get(resolved, { headers: REQUEST_HEADERS }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode ?? "unknown"} for ${resolved}`));
        return;
      }
      const writer = createWriteStream(dest);
      pipeline(res, writer).then(resolve).catch(reject);
    });
    req.on("error", reject);
  });
}

/**
 * Follow HTTP redirects and return the final URL.
 * Node's http.get does not follow redirects automatically.
 */
async function resolveRedirects(url: string, depth = 0): Promise<string> {
  if (depth > 5) throw new Error(`Too many redirects for ${url}`);

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const req = protocol.request(url, { method: "HEAD", headers: REQUEST_HEADERS }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(resolveRedirects(res.headers.location, depth + 1));
      } else {
        resolve(url);
      }
    });
    req.on("error", reject);
    req.end();
  });
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
