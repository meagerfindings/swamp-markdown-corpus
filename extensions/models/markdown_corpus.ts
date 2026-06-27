/**
 * @module markdown_corpus
 *
 * `@mgreten/markdown-corpus` — ingest a directory of dated markdown notes and
 * extract typed, queryable structure: a date-filtered file inventory, headings,
 * matched signal keywords (with the surrounding line as a citation), and
 * extracted reference tokens such as PR numbers and ticket IDs.
 *
 * Deterministic by design: this model parses, it does not summarize. Judgment
 * and synthesis belong at the report/agent layer that consumes the typed
 * output. That keeps the model's behavior observable and cheap to re-run, and
 * lets you point it at the same corpus repeatedly (e.g. each review cycle, each
 * sprint retro) by changing only the filter arguments.
 */

import { z } from "npm:zod@4";

/** Global arguments controlling which files are scanned and what to extract. */
const GlobalArgsSchema: z.ZodObject = z.object({
  /** Absolute path to the directory containing markdown notes. */
  directory: z.string(),
  /**
   * Filename date prefixes to include (e.g. ["2025-12","2026-01"]). A file is
   * included if its name starts with any prefix. Omit to include all *.md.
   */
  datePrefixes: z.array(z.string()).default([]),
  /**
   * Case-insensitive substrings; files whose name contains any are included
   * even if they don't match a date prefix (e.g. ["standup","retro"]).
   */
  nameContains: z.array(z.string()).default([]),
  /**
   * Signal keywords to count and locate across note bodies. Each match records
   * the file and the surrounding line. Drives the "signalRollups" output.
   */
  signalKeywords: z.array(z.string()).default([]),
  /** Max characters of body text to retain per file (keeps output bounded). */
  maxBodyChars: z.number().default(4000),
  /**
   * When true, descend into subdirectories. The `file` field of each digest
   * then holds the path relative to `directory` (e.g. "2025/notes.md").
   * Defaults to false (scan only the top level).
   */
  recursive: z.boolean().default(false),
});

/** A single signal-keyword match: which keyword, in which file, on what line. */
const SignalHitSchema: z.ZodObject = z.object({
  keyword: z.string(),
  file: z.string(),
  line: z.string(),
});

/** Per-file extracted structure. */
const FileDigestSchema: z.ZodObject = z.object({
  file: z.string(),
  inferredDate: z.string().nullable(),
  headings: z.array(z.string()),
  wordCount: z.number(),
  prRefs: z.array(z.string()),
  ticketRefs: z.array(z.string()),
  body: z.string(),
});

/** Aggregate count of a keyword across the corpus, with the files it hit. */
const SignalRollupSchema: z.ZodObject = z.object({
  keyword: z.string(),
  count: z.number(),
  files: z.array(z.string()),
});

/** The full corpus digest written as the model's `corpus` resource. */
const CorpusSchema: z.ZodObject = z.object({
  directory: z.string(),
  generatedAt: z.iso.datetime(),
  fileCount: z.number(),
  totalWords: z.number(),
  dateRange: z.object({
    earliest: z.string().nullable(),
    latest: z.string().nullable(),
  }),
  signalRollups: z.array(SignalRollupSchema),
  signalHits: z.array(SignalHitSchema),
  files: z.array(FileDigestSchema),
});

const DATE_RE = /(\d{4})[-,._ ]?(\d{2})[-,._ ]?(\d{2})/;
const PR_RE = /#(\d{3,6})\b|\bPR[-\s]?(\d{3,6})\b/gi;
const TICKET_RE = /\b([A-Z]{2,5}-\d{1,5})\b/g;

/** Infer an ISO date (YYYY-MM-DD) from a filename, or null if none is present. */
function inferDate(name: string): string | null {
  const m = name.match(DATE_RE);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Extract markdown headings (levels 1-4), capped to keep output bounded. */
function extractHeadings(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /^#{1,4}\s+\S/.test(l))
    .map((l) => l.replace(/^#{1,4}\s+/, "").trim())
    .slice(0, 40);
}

/** Deduplicate an array while preserving first-seen order. */
function uniq(arr: string[]): string[] {
  return [...new Set(arr)];
}

/** A markdown file located during a scan. */
type WalkedFile = { relPath: string; fullPath: string; baseName: string };

/**
 * Yield markdown files under `root`. When `recursive` is false, only the top
 * level is scanned; when true, all nested subdirectories are walked. `relPath`
 * is relative to `root` (so nested files are disambiguated); `baseName` is the
 * filename alone, used for date-prefix / name-substring matching.
 */
async function* walkMarkdown(
  root: string,
  recursive: boolean,
  prefix = "",
): AsyncGenerator<WalkedFile> {
  const base = root.replace(/\/$/, "");
  for await (const entry of Deno.readDir(base)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      if (recursive) yield* walkMarkdown(`${base}/${entry.name}`, true, rel);
      continue;
    }
    if (entry.isFile && entry.name.endsWith(".md")) {
      yield {
        relPath: rel,
        fullPath: `${base}/${entry.name}`,
        baseName: entry.name,
      };
    }
  }
}

/** The subset of the swamp model execution context this model uses. */
type ModelContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
};

/**
 * The `markdown-corpus` model definition. Exposes a single `ingest` method that
 * scans the configured directory and writes one `corpus` resource.
 */
export const model = {
  type: "@mgreten/markdown-corpus",
  version: "2026.06.27.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "corpus": {
      description:
        "Structured digest of a directory of dated markdown notes: per-file headings, PR/ticket refs, body text, and signal-keyword rollups.",
      schema: CorpusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    ingest: {
      description:
        "Scan a directory of markdown notes, filter by date prefix / name substring, and extract typed structure plus signal-keyword hits.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = context.globalArgs;

        const matchName = (baseName: string): boolean => {
          const lower = baseName.toLowerCase();
          if (g.nameContains.some((s) => lower.includes(s.toLowerCase()))) {
            return true;
          }
          if (g.datePrefixes.length === 0 && g.nameContains.length === 0) {
            return true;
          }
          return g.datePrefixes.some((p) => baseName.startsWith(p));
        };

        const fileDigests: z.infer<typeof FileDigestSchema>[] = [];
        const signalHits: z.infer<typeof SignalHitSchema>[] = [];
        const keywordsLower = g.signalKeywords.map((k) => k.toLowerCase());

        for await (const wf of walkMarkdown(g.directory, g.recursive)) {
          if (!matchName(wf.baseName)) continue;
          const text = await Deno.readTextFile(wf.fullPath);
          const words = text.split(/\s+/).filter(Boolean).length;

          const prRefs = uniq(
            [...text.matchAll(PR_RE)].map((m) => `#${m[1] ?? m[2]}`),
          ).slice(0, 50);
          const ticketRefs = uniq(
            [...text.matchAll(TICKET_RE)].map((m) => m[1]),
          ).slice(0, 50);

          if (keywordsLower.length > 0) {
            const lines = text.split("\n");
            for (const line of lines) {
              const ll = line.toLowerCase();
              for (let i = 0; i < keywordsLower.length; i++) {
                if (ll.includes(keywordsLower[i])) {
                  signalHits.push({
                    keyword: g.signalKeywords[i],
                    file: wf.relPath,
                    line: line.trim().slice(0, 240),
                  });
                }
              }
            }
          }

          fileDigests.push({
            file: wf.relPath,
            inferredDate: inferDate(wf.baseName),
            headings: extractHeadings(text),
            wordCount: words,
            prRefs,
            ticketRefs,
            body: text.slice(0, g.maxBodyChars),
          });
        }

        if (fileDigests.length === 0) {
          throw new Error(
            `No markdown files matched in ${g.directory} (datePrefixes=${
              g.datePrefixes.join(",")
            } nameContains=${g.nameContains.join(",")})`,
          );
        }

        fileDigests.sort((a, b) =>
          (a.inferredDate ?? a.file).localeCompare(b.inferredDate ?? b.file)
        );

        const cappedHits = signalHits.slice(0, 500);
        const rollups = g.signalKeywords.map((kw) => {
          const hits = signalHits.filter((h) => h.keyword === kw);
          return {
            keyword: kw,
            count: hits.length,
            files: uniq(hits.map((h) => h.file)).slice(0, 50),
          };
        }).sort((a, b) => b.count - a.count);

        const dates = fileDigests
          .map((f) => f.inferredDate)
          .filter((d): d is string => !!d)
          .sort();

        context.logger.info(
          "Ingested {n} files, {w} words, {h} signal hits",
          {
            n: fileDigests.length,
            w: fileDigests.reduce((s, f) => s + f.wordCount, 0),
            h: signalHits.length,
          },
        );

        const handle = await context.writeResource("corpus", "current", {
          directory: g.directory,
          generatedAt: new Date().toISOString(),
          fileCount: fileDigests.length,
          totalWords: fileDigests.reduce((s, f) => s + f.wordCount, 0),
          dateRange: {
            earliest: dates[0] ?? null,
            latest: dates[dates.length - 1] ?? null,
          },
          signalRollups: rollups,
          signalHits: cappedHits,
          files: fileDigests,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
