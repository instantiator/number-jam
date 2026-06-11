/**
 * License plate format definitions by region.
 * Generated from Wikipedia regional vehicle registration plate articles and manually curated.
 * Run `npm run generate-formats` to refresh from Wikipedia.
 */

/** A known license plate format for a specific region or country. */
export interface PlateFormat {
  /** ISO 3166-1 alpha-2 country code, or region sub-code (e.g. "us-ca" for California). */
  code: string;
  /** Human-readable description of the format. */
  description: string;
  /** Regex that matches a valid plate in this format (spaces stripped, upper-cased). */
  regex: RegExp;
  /** Example plate strings that must match the regex. */
  examples: string[];
  /** Example plate strings that must NOT match the regex. */
  nonExamples: string[];
}

/** All known plate formats, ordered by region then country code. */
export const PLATE_FORMATS: PlateFormat[] = [
  // ── Europe ────────────────────────────────────────────────────────────────

  {
    code: "gb",
    description: "2 letters (area code) + 2 digits (year) + 3 letters (random)",
    regex: /^[A-Z]{2}\d{2}[A-Z]{3}$/,
    examples: ["AB12CDE", "SW63FGH", "LK21TZR"],
    nonExamples: ["AB1CDE", "123ABCD", "ABCDEFG", "AB12CD"],
  },
  {
    code: "de",
    description:
      "1–3 letter district code + 1–2 letters + 1–4 digits (optional H/E suffix for historic/electric)",
    regex: /^[A-ZÄÖÜ]{1,3}[A-Z]{1,2}\d{1,4}[HE]?$/,
    examples: ["BXYZ1234", "MABC99", "FFB21H", "S A1"],
    nonExamples: ["12ABC", "TOOLONGCODE1234", ""],
  },
  {
    code: "fr",
    description: "2 letters + 3 digits + 2 letters (since 2009)",
    regex: /^[A-Z]{2}\d{3}[A-Z]{2}$/,
    examples: ["AB123CD", "ZZ999ZZ", "AA001BB"],
    nonExamples: ["A123CD", "AB1234CD", "12ABCDE"],
  },
  {
    code: "es",
    description: "4 digits + 3 letters (since 2000)",
    regex: /^\d{4}[A-Z]{3}$/,
    examples: ["1234ABC", "9999ZZZ", "0001BBB"],
    nonExamples: ["123ABC", "12345ABC", "ABCD123"],
  },
  {
    code: "it",
    description: "2 letters + 3 digits + 2 letters",
    regex: /^[A-Z]{2}\d{3}[A-Z]{2}$/,
    examples: ["AB123CD", "ZZ999ZZ"],
    nonExamples: ["A123CD", "AB1234CD", "1234ABC"],
  },
  {
    code: "nl",
    description: "2 letters + 2 digits + 2 letters (current series), or 2L+3N+1L etc.",
    regex: /^([A-Z]{2}\d{2}[A-Z]{2}|[A-Z]{2}\d{3}[A-Z]|[A-Z]\d{3}[A-Z]{2}|\d{2}[A-Z]{2}\d{2})$/,
    examples: ["AB12CD", "AB123C", "A123BC", "12AB34"],
    nonExamples: ["ABCDEF", "123456", "AB1CD"],
  },
  {
    code: "be",
    description: "1 digit + 3 letters + 3 digits",
    regex: /^\d[A-Z]{3}\d{3}$/,
    examples: ["1ABC234", "9ZZZ999"],
    nonExamples: ["ABC234", "1AB234", "12ABC34"],
  },
  {
    code: "pl",
    description: "2–3 letter district code + 5 alphanumeric characters",
    regex: /^[A-Z]{2,3}[A-Z0-9]{5}$/,
    examples: ["WA12345", "KRA1234", "GDBP123"],
    nonExamples: ["W12345", "WABC12", "123456"],
  },
  {
    code: "pt",
    description: "2 letters + 2 digits + 2 letters (since 2005)",
    regex: /^[A-Z]{2}\d{2}[A-Z]{2}$/,
    examples: ["AB12CD", "ZZ99ZZ"],
    nonExamples: ["AB1CD", "AB123CD", "1234AB"],
  },
  {
    code: "se",
    description: "3 letters + 3 digits (or 3L+2N+1L since 2022)",
    regex: /^[A-Z]{3}\d{3}$|^[A-Z]{3}\d{2}[A-Z]$/,
    examples: ["ABC123", "ZZZ999", "ABC12A"],
    nonExamples: ["AB123", "ABCD123", "1234AB"],
  },
  {
    code: "no",
    description: "2 letters + 5 digits",
    regex: /^[A-Z]{2}\d{5}$/,
    examples: ["AB12345", "ZZ99999"],
    nonExamples: ["AB1234", "ABC12345", "1234567"],
  },
  {
    code: "dk",
    description: "2 letters + 5 digits",
    regex: /^[A-Z]{2}\d{5}$/,
    examples: ["AB12345", "ZZ99999"],
    nonExamples: ["AB1234", "A12345", "12AB345"],
  },
  {
    code: "fi",
    description: "2–3 letters + 1–3 digits (dashes stripped)",
    regex: /^[A-Z]{2,3}\d{1,3}$/,
    examples: ["AB1", "ABC123", "XY99"],
    nonExamples: ["A1", "ABCD123", "AB1234"],
  },
  {
    code: "at",
    description: "1–3 letter district + 1–2 letters + 1–4 digits",
    regex: /^[A-Z]{1,3}[A-Z]{1,2}\d{1,4}$/,
    examples: ["WAB1234", "GBCD99", "LZA1"],
    nonExamples: ["1234AB", "TOOLONGAAA", ""],
  },
  {
    code: "ch",
    description: "2 letter canton code + 1–6 digits",
    regex: /^[A-Z]{2}\d{1,6}$/,
    examples: ["ZH1", "ZH123456", "BE9999"],
    nonExamples: ["Z123", "ZH1234567", "123456"],
  },
  {
    code: "ie",
    description: "2–3 digits (year/half-year) + 1–2 letter county code + 1–6 digits",
    regex: /^\d{2,3}[A-Z]{1,2}\d{1,6}$/,
    examples: ["191D12345", "22C1", "99MH999999"],
    nonExamples: ["1AB123", "ABC123", "1234567"],
  },
  {
    code: "gr",
    description: "3 letters + 4 digits",
    regex: /^[A-Z]{3}\d{4}$/,
    examples: ["ABC1234", "ZZZ9999"],
    nonExamples: ["AB1234", "ABCD1234", "1234ABC"],
  },
  {
    code: "cz",
    description: "1 digit + 1 letter + 2 digits + 4 digits (district + serial)",
    regex: /^\d[A-Z]\d{2}\d{4}$/,
    examples: ["1A234567", "9Z991234"],
    nonExamples: ["AB12345", "1A2345", "12345678"],
  },
  {
    code: "hu",
    description: "3 letters + 3 digits",
    regex: /^[A-Z]{3}\d{3}$/,
    examples: ["ABC123", "ZZZ999"],
    nonExamples: ["AB123", "ABCD123", "1234AB"],
  },
  {
    code: "ro",
    description: "1–2 letter county code + 2 digits + 3 letters (Bucharest uses single-letter B)",
    regex: /^[A-Z]{1,2}\d{2}[A-Z]{3}$/,
    examples: ["B12ABC", "CJ99ZZZ"],
    nonExamples: ["B1ABC", "B123ABC", "12ABCDE"],
  },
  {
    code: "ru",
    description: "1 letter + 3 digits + 2 letters + 2–3 region digits",
    regex: /^[A-Z]\d{3}[A-Z]{2}\d{2,3}$/,
    examples: ["A123BC77", "X999ZZ177"],
    nonExamples: ["123ABC77", "A12BC77", "A123B77"],
  },
  {
    code: "tr",
    description: "2 digit province code + 1–3 letters + 2–4 digits",
    regex: /^\d{2}[A-Z]{1,3}\d{2,4}$/,
    examples: ["34ABC1234", "06A12", "35BC999"],
    nonExamples: ["3AB123", "ABC1234", "3456ABC12"],
  },

  // ── Americas ──────────────────────────────────────────────────────────────

  {
    code: "us",
    description: "Varies by state; generally 2–7 alphanumeric characters",
    regex: /^[A-Z0-9]{2,7}$/,
    examples: ["ABC1234", "1ABC234", "123ABC", "XYZ789"],
    nonExamples: ["A", "ABCDEFGHIJ"],
  },
  {
    code: "ca",
    description: "Varies by province; generally 4–7 alphanumeric characters",
    regex: /^[A-Z0-9]{4,7}$/,
    examples: ["ABCD123", "123ABC", "1234AB"],
    nonExamples: ["ABC", "ABCDEFGH"],
  },
  {
    code: "br",
    description:
      "3 letters + 4 digits (old), or 3 letters + 1 digit + 1 letter + 2 digits (Mercosur)",
    regex: /^[A-Z]{3}\d{4}$|^[A-Z]{3}\d[A-Z]\d{2}$/,
    examples: ["ABC1234", "ABC1D23"],
    nonExamples: ["AB1234", "ABC12345", "1234ABC"],
  },
  {
    code: "mx",
    description: "3 letters + 4 digits (federal) or 3 letters + 3 digits + 2 letters (state formats, dashes stripped)",
    regex: /^[A-Z]{3}\d{4}$|^[A-Z]{3}\d{3}[A-Z]{2}$/,
    examples: ["ABC1234", "ABC123DE"],
    nonExamples: ["AB1234", "1234ABC"],
  },
  {
    code: "ar",
    description: "3 letters + 3 digits (old), or 2 letters + 3 digits + 2 letters (Mercosur)",
    regex: /^[A-Z]{3}\d{3}$|^[A-Z]{2}\d{3}[A-Z]{2}$/,
    examples: ["ABC123", "AB123CD"],
    nonExamples: ["AB123", "ABCD123", "1234AB"],
  },
  {
    code: "cl",
    description: "4 letters + 2 digits (since 2007) or 2 letters + 4 digits (old)",
    regex: /^[A-Z]{4}\d{2}$|^[A-Z]{2}\d{4}$/,
    examples: ["ABCD12", "AB1234"],
    nonExamples: ["ABC123", "AB12345"],
  },
  {
    code: "co",
    description: "3 letters + 3 digits",
    regex: /^[A-Z]{3}\d{3}$/,
    examples: ["ABC123", "ZZZ999"],
    nonExamples: ["AB123", "ABC1234"],
  },

  // ── Asia-Pacific ──────────────────────────────────────────────────────────

  {
    code: "au",
    description:
      "Varies by state; commonly 3 letters + 3 digits, or 3 letters + 2 digits + 1 letter",
    regex: /^[A-Z]{3}\d{3}$|^[A-Z]{3}\d{2}[A-Z]$|^[A-Z0-9]{5,7}$/,
    examples: ["ABC123", "ABC12D", "1ABC23"],
    nonExamples: ["AB12", "ABCDEFGH"],
  },
  {
    code: "nz",
    description: "3 letters + 3 digits",
    regex: /^[A-Z]{3}\d{3}$/,
    examples: ["ABC123", "ZZZ999"],
    nonExamples: ["AB123", "ABCD123", "1234AB"],
  },
  {
    code: "in",
    description: "2 letter state code + 2 alphanumeric district code + 1–2 letters + 4 digits",
    regex: /^[A-Z]{2}[A-Z0-9]{2}[A-Z]{1,2}\d{4}$/,
    examples: ["MH01AB1234", "DL2CAB1234", "KA01B1234"],
    nonExamples: ["MH01AB12345", "MH01A12345", "123ABCD"],
  },
  {
    code: "jp",
    description: "Prefecture name (kanji) + classification number + hiragana + 4 digits (Latin OCR: XX-NNNN)",
    regex: /^[A-Z0-9]{1,4}-?\d{1,4}$/,
    examples: ["500-1234", "3301", "AB1234"],
    nonExamples: ["ABCDEFGH", ""],
  },
  {
    code: "kr",
    description: "3 digits + 1 hangul character + 4 digits (Latin OCR approximation)",
    regex: /^\d{3}[A-Z]\d{4}$/,
    examples: ["123A4567", "999Z9999"],
    nonExamples: ["12A4567", "1234A567", "ABCDEFG"],
  },
  {
    code: "sg",
    description: "1–3 letters + 1–4 digits + 1 check letter",
    regex: /^[A-Z]{1,3}\d{1,4}[A-Z]$/,
    examples: ["SBA1234A", "SGX1Z", "E123B"],
    nonExamples: ["1234AB", "ABCDE", "SBA12345A"],
  },
  {
    code: "my",
    description: "1–3 letters + 1–4 digits (optional suffix letter)",
    regex: /^[A-Z]{1,3}\d{1,4}[A-Z]?$/,
    examples: ["ABC1234", "A1234", "WXY99Z"],
    nonExamples: ["1234ABC", "ABCDE1234"],
  },
  {
    code: "th",
    description: "2 Thai characters + 1–4 digits (Latin OCR: 2L+1–4N)",
    regex: /^[A-Z]{2}\d{1,4}$/,
    examples: ["AB1234", "ZZ9"],
    nonExamples: ["A1234", "ABC12345", "1234AB"],
  },
  {
    code: "id",
    description: "1–2 letter area code + 1–4 digits + 1–3 letters",
    regex: /^[A-Z]{1,2}\d{1,4}[A-Z]{1,3}$/,
    examples: ["B1234ABC", "D999AB", "AB1A"],
    nonExamples: ["1234ABC", "ABCDE", "B12345ABCD"],
  },
  {
    code: "ph",
    description: "3 letters + 3–4 digits",
    regex: /^[A-Z]{3}\d{3,4}$/,
    examples: ["ABC123", "ABC1234"],
    nonExamples: ["AB123", "ABCD1234", "1234ABC"],
  },
  {
    code: "hk",
    description: "2 letters + 4 digits",
    regex: /^[A-Z]{2}\d{4}$/,
    examples: ["AB1234", "ZZ9999"],
    nonExamples: ["AB123", "ABC1234", "1234AB"],
  },
  {
    code: "tw",
    description: "3 letters + 4 digits (cars) or 3 letters + 3 digits (motorcycles)",
    regex: /^[A-Z]{3}\d{3,4}$/,
    examples: ["ABC1234", "ABC123"],
    nonExamples: ["AB1234", "ABCD1234"],
  },

  // ── Middle East & Africa ──────────────────────────────────────────────────

  {
    code: "ae",
    description: "1–5 digits (emirate plates are number-only)",
    regex: /^\d{1,5}$/,
    examples: ["12345", "1", "999"],
    nonExamples: ["123456", "ABC", "A123"],
  },
  {
    code: "sa",
    description: "3 letters + 4 digits (Latin transliteration of Arabic)",
    regex: /^[A-Z]{3}\d{4}$/,
    examples: ["ABC1234", "ZZZ9999"],
    nonExamples: ["AB1234", "ABCD1234"],
  },
  {
    code: "za",
    description: "2 letter province code + 2 digits + 2 letters + 2 digits (GP format) or similar",
    regex: /^[A-Z]{2}\d{2}[A-Z]{2}\d{2}$|^[A-Z]{2}\d{3}[A-Z]{3}$/,
    examples: ["GP12AB34", "WC123ABC"],
    nonExamples: ["ABC123", "GP1AB34", "123ABCDE"],
  },
  {
    code: "ke",
    description: "3 letters + 3 digits + 1 letter",
    regex: /^[A-Z]{3}\d{3}[A-Z]$/,
    examples: ["KAA123A", "KBZ999Z"],
    nonExamples: ["KA123A", "KAA1234", "1234ABC"],
  },
  {
    code: "ng",
    description: "3 letters + 3 digits + 2 letters (state code suffix)",
    regex: /^[A-Z]{3}\d{3}[A-Z]{2}$/,
    examples: ["ABC123LA", "XYZ999AB"],
    nonExamples: ["AB123LA", "ABC1234LA", "ABC123L"],
  },
];
