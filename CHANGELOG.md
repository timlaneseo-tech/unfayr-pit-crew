# Changelog

## 1.0.2 - 2026-10-09

Fixes from a 1,682-product Shopify run.

- `crawl --offset N` skips the first N pages of the chosen sections, so a section over the 1,000-page cap can run in parts (for example `--include products --offset 1000` with a new `--date` label).
- A rate-limited store no longer loses pages. A 429 or 503 is retried up to 5 times with backoff (2, 4, 8, 16 s, or the server's Retry-After), and after the first one the rest of the crawl runs one page at a time with a 1 s gap.
- Publishing to Shopify retries transient 502, 503 and 504 answers like a throttle. SEO field writes are idempotent, so a retry is safe.
- Saving onpage.json on Windows retries when a virus scanner or the indexer holds the file, then falls back to copying, instead of warning on every change.

## 1.0.1 - 2026-10-09

Fixes from a first run on a Shopify store.

- The brand guess no longer takes the first host label (parts.rtlequipment.com was guessed as "Parts"). It now prefers the name most page titles end or start with after a separator, and otherwise uses the main domain name with subdomains such as www, shop and parts ignored.
- `--include home` (also `root` or `/`) selects the homepage when a site is over the page cap. The first crawl lists the homepage as `home`.
- The top 25 no longer fall back to alphabetical order when click data is thin. Pages with click data keep their click order. Among pages without clicks, those matching your categories or main services come first (a match in the page address before a match in the title, brand name ignored), privacy, opt-out, cart and similar pages go last, and near-empty pages rank after pages with content.

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
