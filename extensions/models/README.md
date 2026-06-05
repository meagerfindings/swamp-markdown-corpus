# @mgreten/markdown-corpus

A swamp model that ingests a directory of dated markdown notes and turns it into
typed, queryable structure. It is a **deterministic parser, not a summarizer**:
it extracts a date-filtered file inventory, headings, PR/ticket reference tokens,
and signal-keyword rollups (each match keeps the surrounding line as a citation).
Synthesis and judgment stay at whatever report or agent layer consumes the
output, which keeps this model cheap to re-run against the same corpus every
cycle — daily-journal reviews, sprint retros, research notes, performance-review
prep, or any pile of dated `*.md` files.

## Installation

```bash
swamp extension pull @mgreten/markdown-corpus
```

## Setup

Create a model instance pointed at your notes directory. Array arguments are
easiest to set by editing the generated definition YAML, but simple runs work
from the CLI:

```bash
swamp model create @mgreten/markdown-corpus my-notes \
  --global-arg "directory=/path/to/notes"
```

To filter and extract signals, edit the instance definition YAML
(`models/@mgreten/markdown-corpus/<id>.yaml`):

```yaml
globalArguments:
  directory: /path/to/notes
  datePrefixes:
    - "2026-05"
    - "2026-06"
  nameContains: []
  signalKeywords:
    - shipped
    - blocker
    - decision
  maxBodyChars: 4000
```

## Usage

Run the `ingest` method to scan the directory and write the `corpus` resource:

```bash
swamp model method run my-notes ingest
swamp data get my-notes current --json
```

## Global Arguments

| Argument         | Type       | Default | Description                                                                 |
| ---------------- | ---------- | ------- | --------------------------------------------------------------------------- |
| `directory`      | `string`   | —       | Absolute path to the directory of markdown notes (required).                |
| `datePrefixes`   | `string[]` | `[]`    | Include files whose name starts with any of these prefixes (e.g. `2026-06`).|
| `nameContains`   | `string[]` | `[]`    | Include files whose name contains any of these case-insensitive substrings. |
| `signalKeywords` | `string[]` | `[]`    | Keywords to count and locate; each hit keeps its surrounding line.          |
| `maxBodyChars`   | `number`   | `4000`  | Max characters of body text retained per file.                              |
| `recursive`      | `boolean`  | `false` | Descend into subdirectories; `file` then holds the path relative to `directory`. |

When both `datePrefixes` and `nameContains` are empty, every `*.md` file in the
directory is included.

## Method: ingest

Scans the directory, applies the filters, and writes one `corpus` resource.

| Argument | Type | Description                |
| -------- | ---- | -------------------------- |
| _(none)_ | —    | All inputs are globalArgs. |

The `corpus` resource contains: `fileCount`, `totalWords`, `dateRange`,
`signalRollups` (keyword → count + files), `signalHits` (capped list of
keyword/file/line citations), and `files` (per-file `headings`, `inferredDate`,
`prRefs`, `ticketRefs`, `wordCount`, and a truncated `body`).

## How It Works

The model reads each matching file with Deno's filesystem API, infers a date
from the filename, extracts markdown headings (levels 1–4), pulls PR references
(`#1234`, `PR-1234`) and ticket IDs (`ABC-123`) with regexes, and counts each
configured signal keyword line by line. Output is sorted by inferred date and
bounded (headings capped at 40, refs at 50, signal hits at 500, body at
`maxBodyChars`) so the resource stays a reasonable size on large corpora. It
requires no network access and no dependencies beyond `zod`.

## License

MIT — see LICENSE for details.
