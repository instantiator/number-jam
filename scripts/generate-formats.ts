#!/usr/bin/env tsx
/**
 * Build script: scrapes Wikipedia regional vehicle registration plate pages
 * and augments src/regions/plate-formats.ts with any formats not already present.
 *
 * Usage: npm run generate-formats
 *
 * The output file is checked in — run this script when you want to refresh
 * coverage from Wikipedia. Manual edits in plate-formats.ts are preserved
 * for codes that already exist; only new codes are appended.
 */

import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";

/** Wikipedia pages that contain structured plate format tables by region. */
const WIKIPEDIA_PAGES = [
  "Vehicle_registration_plates_of_Europe",
  "Vehicle_registration_plates_of_the_Americas",
  "Vehicle_registration_plates_of_Asia",
  "Vehicle_registration_plates_of_Oceania",
  "Vehicle_registration_plates_of_Africa",
];

/** A scraped plate format row before regex derivation. */
interface ScrapedFormat {
  code: string;
  description: string;
  example: string;
}

/** Derive a best-effort regex string from a format description or example. */
function deriveRegex(description: string, example: string): string {
  // Prefer deriving from the example plate string when available.
  if (example && /^[A-Z0-9 \-·.]{2,12}$/.test(example.toUpperCase())) {
    const normalised = example.toUpperCase().replace(/[\s\-·.]/g, "");
    let pattern = "";
    let i = 0;
    while (i < normalised.length) {
      const ch = normalised[i];
      if (/[A-Z]/.test(ch)) {
        let count = 0;
        while (i < normalised.length && /[A-Z]/.test(normalised[i])) {
          count++;
          i++;
        }
        pattern += count === 1 ? "[A-Z]" : `[A-Z]{${count}}`;
      } else if (/\d/.test(ch)) {
        let count = 0;
        while (i < normalised.length && /\d/.test(normalised[i])) {
          count++;
          i++;
        }
        pattern += count === 1 ? "\\d" : `\\d{${count}}`;
      } else {
        i++;
      }
    }
    if (pattern) return `^${pattern}$`;
  }

  // Fall back to description-based heuristics.
  const desc = description.toLowerCase();
  let pattern = "";

  // Match tokens like "3 letters", "2 digits", "4 alphanumeric"
  const tokenRe = /(\d+)\s*(letter|digit|alpha|number|character)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(desc)) !== null) {
    const count = parseInt(match[1], 10);
    const kind = match[2];
    if (kind.startsWith("letter") || kind.startsWith("alpha")) {
      pattern += `[A-Z]{${count}}`;
    } else if (kind.startsWith("digit") || kind.startsWith("number")) {
      pattern += `\\d{${count}}`;
    } else {
      pattern += `[A-Z0-9]{${count}}`;
    }
  }

  return pattern ? `^${pattern}$` : "^[A-Z0-9]{2,8}$";
}

/** Convert a two-letter country name abbreviation to an ISO 3166-1 alpha-2 code. */
function normaliseCode(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 6);
}

/** Fetch a Wikipedia page and return its HTML. */
async function fetchWikiPage(title: string): Promise<string> {
  const url = `https://en.wikipedia.org/wiki/${title}`;
  process.stderr.write(`Fetching ${url} …\n`);
  const res = await fetch(url, {
    headers: { "User-Agent": "number-jam plate-format generator (educational)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Extract plate format rows from a Wikipedia page HTML. */
function extractFormats(html: string, pageTitle: string): ScrapedFormat[] {
  const $ = cheerio.load(html);
  const results: ScrapedFormat[] = [];

  // Look for wikitables with columns that indicate plate format data.
  $("table.wikitable").each((_i, table) => {
    const headers: string[] = [];
    $(table)
      .find("tr:first-child th")
      .each((_j, th) => {
        headers.push($(th).text().trim().toLowerCase());
      });

    const codeCol = headers.findIndex(
      (h) => h.includes("country") || h.includes("code") || h.includes("nation")
    );
    const formatCol = headers.findIndex(
      (h) => h.includes("format") || h.includes("pattern") || h.includes("description")
    );
    const exampleCol = headers.findIndex(
      (h) => h.includes("example") || h.includes("sample") || h.includes("plate")
    );

    if (codeCol === -1 || formatCol === -1) return;

    $(table)
      .find("tr")
      .slice(1)
      .each((_j, row) => {
        const cells = $(row).find("td");
        if (cells.length < Math.max(codeCol, formatCol) + 1) return;

        const rawCode = $(cells[codeCol]).text().trim();
        const description = $(cells[formatCol]).text().trim();
        const example = exampleCol !== -1 ? $(cells[exampleCol]).text().trim() : "";

        const code = normaliseCode(rawCode);
        if (!code || !description) return;

        results.push({ code, description, example });
      });
  });

  if (results.length === 0) {
    process.stderr.write(`  No structured tables found in ${pageTitle}\n`);
  } else {
    process.stderr.write(`  Found ${results.length} format rows in ${pageTitle}\n`);
  }
  return results;
}

/** Read the existing plate-formats.ts and return already-known codes. */
function existingCodes(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  const content = fs.readFileSync(filePath, "utf-8");
  const matches = content.matchAll(/code:\s*"([^"]+)"/g);
  return new Set([...matches].map((m) => m[1]));
}

/** Render a new PlateFormat entry as TypeScript source. */
function renderEntry(fmt: ScrapedFormat): string {
  const regexStr = deriveRegex(fmt.description, fmt.example);
  const example = fmt.example
    ? fmt.example.toUpperCase().replace(/[\s\-·.]/g, "")
    : "";
  const exampleList = example ? `["${example}"]` : '["TODO"]';
  const desc = fmt.description.replace(/"/g, '\\"').slice(0, 120);

  return `  {
    code: "${fmt.code}",
    description: "${desc}",
    regex: /${regexStr}/,
    examples: ${exampleList},
    nonExamples: ["TODO_NON_EXAMPLE"],
  },`;
}

async function main(): Promise<void> {
  const outFile = path.resolve(__dirname, "../src/regions/plate-formats.ts");
  const known = existingCodes(outFile);

  process.stderr.write(`Existing codes in plate-formats.ts: ${known.size}\n`);

  const newEntries: string[] = [];

  for (const page of WIKIPEDIA_PAGES) {
    let html: string;
    try {
      html = await fetchWikiPage(page);
    } catch (err) {
      process.stderr.write(`  Skipping ${page}: ${(err as Error).message}\n`);
      continue;
    }

    const formats = extractFormats(html, page);
    for (const fmt of formats) {
      if (!known.has(fmt.code)) {
        newEntries.push(renderEntry(fmt));
        known.add(fmt.code);
      }
    }
  }

  if (newEntries.length === 0) {
    process.stderr.write("No new formats discovered — plate-formats.ts is up to date.\n");
    return;
  }

  process.stderr.write(`Appending ${newEntries.length} new format entries …\n`);

  // Append new entries before the closing ]; in the PLATE_FORMATS array.
  const content = fs.readFileSync(outFile, "utf-8");
  const insertPoint = content.lastIndexOf("];");
  if (insertPoint === -1) {
    process.stderr.write("ERROR: could not find closing ]; in plate-formats.ts\n");
    process.exit(1);
  }

  const updated =
    content.slice(0, insertPoint) +
    "\n  // ── Scraped from Wikipedia ──────────────────────────────────────────────\n\n" +
    newEntries.join("\n") +
    "\n" +
    content.slice(insertPoint);

  fs.writeFileSync(outFile, updated, "utf-8");
  process.stderr.write(`Done. Updated ${outFile}\n`);
}

main().catch((err) => {
  process.stderr.write(`generate-formats failed: ${err.message}\n`);
  process.exit(1);
});
