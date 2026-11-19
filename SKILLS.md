# Writing skills for Vault Dweller

A skill is a folder with a `SKILL.md` in a public GitHub repository. Vault Dweller
imports it on the Skills tab ("Import from GitHub"), shows what it can do, and runs it
on your AI key against the Vault you are signed in to.

The folder has the same shape as Claude's Agent Skills, so one folder works in both.

## The folder

```
my-skill/
  SKILL.md              required: front matter, then the instructions
  reference/notes.md    optional: files the skill reads when its steps say so
```

Only text files are imported (`.md .txt .csv .tsv .json .vql .sql .yaml .yml .xml .html`):
up to 40 files, 200 KB each, 1 MB in all. Scripts (`.py`, `.js`, `.sh`, …) are listed in
the preview and skipped: a Chrome extension can't run code it didn't ship with. A skill
works through the extension's tools instead.

## SKILL.md

```markdown
---
name: mlr-status-report
description: Counts promotional pieces by MLR status for a document type and period.
  Use when someone asks where review stands.
metadata:
  vault-dweller-access: read
  vault-dweller-tools: run_vql, doc_type_fields, open_query
  vault-dweller-inputs: "doc_type: Document type; period: Period [30 days|90 days|365 days]"
  version: "1.2"
---

# MLR status report

1. Read the type's fields with doc_type_fields …
```

| Key | |
| --- | --- |
| `name` | Required. Lower-case letters, digits and hyphens, 64 at most. |
| `description` | Required. What it does and when to use it, 1,024 characters at most. |
| `metadata.vault-dweller-access` | `read` (the default) or `write`. Only a write skill gets `propose_changes`. |
| `metadata.vault-dweller-tools` | The tools it may call, comma-separated. Leave it out for all the read tools. |
| `metadata.vault-dweller-inputs` | What to ask before a run: `key: Label`, separated by `;`. `[a\|b\|c]` makes a list to choose from. An input named `doc_type` is a document-type picker once types are loaded. |
| `metadata.version` | Shown in the library and the preview. |

The first `# Heading` of the instructions is the skill's title in the extension.

## Tools

| Tool | What it does |
| --- | --- |
| `run_vql` | A read-only query: SELECT or SHOW. Up to 5,000 rows are fetched across pages (MAXROWS is added or capped); the model sees the first 300, the total and a result ID for `export_excel`. |
| `count_by` | Counts a SELECT's rows by one field across every page, up to 250,000 rows: VQL has no GROUP BY, so this is how to count per user, type or status. Returns a result ID, the number of distinct values and the largest counts. |
| `export_excel` | A download button for an Excel file: one row per row of a `run_vql` result, columns from it, a column per `count_by` result, and a Flags column filled by rules the extension applies to every row. Adds an Explanation sheet with the columns, the rules and the queries behind each count. |
| `describe_object` | An object's fields and relationships; `documents` for document fields. |
| `list_doc_types` | The vault's document types. |
| `doc_type_fields` | A document type's fields, with layout sections and picklist values. |
| `picklist_values` | A picklist's values, by picklist name or by a document field. |
| `read_skill_file` | One of the skill's own files. Given automatically when the folder has any. |
| `open_query` | Offers a query as a button that opens it in a new tab, unrun. |
| `propose_changes` | Write skills only. Field changes for documents or an object's records. The user sees each record's current and new value, ticks the rows to apply, and the extension makes those changes, as the user. |

In queries, `{{days_ago:N}}` becomes midnight UTC N days ago as a DateTime
(`2025-11-19T00:00:00.000Z`) and `{{date_days_ago:N}}` the same day as a Date
(`2025-11-19`), so a skill can say "the last 12 months" without the model doing date sums.

Flag rules for `export_excel` are `{col, op, value}`, or `{all: [...]}` / `{any: [...]}`.
`col` is a column's id or title, or a field of the base result that isn't shown. The ops
are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `empty`, `not_empty`, `in`, `not_in`,
`older_than_days` and `within_days`. A rule naming an unknown column is refused, so a typo
can't quietly flag nobody. Because the extension counts and flags every row, the numbers
are exact even when the model has seen only the first 300.

The extension checks every call against the skill's list; a call to anything else is
refused and the model is told so. Nothing the instructions or Vault data say can widen it.

## Running

- Every tool call shows on screen as it happens, with its row count.
- The model gets the skill's instructions, the inputs, and the results of its tool calls.
  Your Vault session and API key never leave the extension's background worker.
- A run stops after 16 model turns.

## Importing and updating

Paste a link on the Skills tab: `github.com/owner/repo`, a folder
(`github.com/owner/repo/tree/main/skills/my-skill`), or the `SKILL.md` itself. A repository
with several skills shows a list to pick from. Chrome asks once for permission to read
GitHub. Files are fetched at the commit the branch points to; **Update** checks for a newer
commit and shows the preview again before installing it.

Public repositories only, read without a GitHub account: GitHub allows about 60 requests
an hour from one address that way, and an import uses three.

This repository's `skills/recent-changes` is a working example:
`github.com/escadesupremo/vault-dweller-extension/tree/main/skills/recent-changes`.
