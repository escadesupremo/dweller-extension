---
name: recent-changes
description: Summarises which documents changed in the vault over a recent period, by document type and lifecycle state, and lists the most recently changed ones. Use when someone asks what has been happening in the vault lately.
metadata:
  vault-dweller-access: read
  vault-dweller-tools: run_vql, list_doc_types, open_query
  vault-dweller-inputs: "period: Period [7 days|30 days|90 days]"
  version: "1.0"
---

# Recent changes

1. Work out the start date: today minus the period the user chose, at midnight UTC,
   written as an ISO timestamp such as 2026-11-11T00:00:00.000Z.
2. Query the documents changed since then with run_vql:
   SELECT id, name__v, document_number__v, type__v, status__v, version_modified_date__v
   FROM documents WHERE version_modified_date__v >= '<start>'
   ORDER BY version_modified_date__v DESC
3. If type__v comes back as API names, call list_doc_types once to show labels instead.
4. Count the rows by document type and by status yourself. Read reference/how-to-read.md
   for what to call out.
5. Answer with one sentence of totals, a table of document types with their counts,
   and the five most recently changed documents.
6. Offer the query from step 2 with open_query, labelled "Open these documents".
