# Changelog

## 1.0.0 - 2026-10-09

First release.

- `/pitcrew <site>` crawls a site (up to 1,000 indexable pages), learns the business in a short interview, reads the search results for the top 25 pages, and writes a new title, meta description and H1 for every page in one naming style.
- One Excel workbook per run: Summary, Pages, Deep fixes, Naming style and Read me tabs, with an Approve column.
- Code-enforced checks on every row: title 30 to 60 and meta 70 to 155 characters, unique titles and metas, the naming convention, no unsourced numbers or claim words, and `[ADD: ...]` slots for facts it does not have. Rows that fail are never published or exported. Pixel width, title and H1 agreement, near-duplicates and past years are warnings: listed in the workbook's Issues column, not blocking.
- Deep fixes follow the same never-invent rule: an unsourced opening, heading, FAQ or alt text becomes an `[ADD: ...]` slot.
- Publishing to Shopify, WordPress (with a CSV route for SEO plugin fields), Webflow and static sites in Git. Dry run against the page as it is served, backup before every publish, an explicit yes, a fresh check of each record just before writing, live verification and a rollback that restores only the fields it applied and that nobody has changed since (clearing fields that were empty before, where the platform allows).
- `status` reports how far a run got, so an interrupted run picks up where it stopped; a same-day re-crawl that finds different pages rebuilds the later steps.
- H1 changes that would rename a record are off unless you opt in.
- `onpage.json` handoff file for Caddie.
- Sample mode: `/pitcrew --sample ridgeline-plumbing.example` runs the whole process on a fictional site with no network.
- Benchmark runner in `evals/` and the first result, `evals/benchmarks/2026-10-pitcrew-v1.md`.
- Public repo export tool, `tools/export_public.ts`. Pit Crew lives at github.com/timlaneseo-tech/unfayr-pit-crew and is listed in the `unfayr` marketplace.

Built by Unfayr · unfayr.com
