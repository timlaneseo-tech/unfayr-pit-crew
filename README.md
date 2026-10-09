<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/pit-crew-lockup-on-dark.svg">
    <img src="assets/pit-crew-lockup-on-light.svg" alt="pit crew by unfayr" width="360">
  </picture>
</p>

<p align="center"><strong>Pit fixes every page in one stop. You drive.</strong></p>

Pit Crew is a free Claude Code plugin for business owners, marketers and agencies. It rewrites the title, meta description and H1 of every page on your site in one consistent naming style, using what your pages say, what the search results look like and a short interview about your business. You review everything in one Excel workbook. It publishes the changes you approve, only when you say yes, and it takes a backup first so you can undo it.

## Just ask

Install it, open Claude Code, and say:

> Run my site example.com through Pit Crew

or type `/pitcrew example.com`.

Pit Crew crawls the site, asks you a handful of questions it cannot answer from your pages (what you do, where you work, what proves you are established), looks at the search results for your most important pages, writes the copy, checks it against its own rules and opens the workbook. When you have ticked the rows you want, say "publish" and it walks you through the rest.

## What you get

One workbook per run, `Pit Crew - <site> - <date>.xlsx`, saved in `Documents/Pit Crew`:

| Tab | What is in it |
|---|---|
| Summary | Before and after numbers for the run: pages read, titles over the limit, pages sharing a title or meta, pages with no H1, your naming style, how many rows are ready, need review or need a fact from you, and the next steps. |
| Pages | One row per page: current title, meta and H1, the new ones, the reason, where the facts came from, an Issues column with anything the checks found, the status and an Approve column. This is the tab you work in. |
| Deep fixes | For the 25 most important pages: a stronger opening paragraph, a suggested outline, questions worth answering and image alt text. Suggestions only. They are never published. |
| Naming style | The single pattern every title follows, so you can see and change the rule, not just the results. |
| Read me | How to approve rows and what the colours mean. |

A real excerpt from the sample run on a fictional plumber (the full run is 12 pages):

| Page | Current title | New title | Status |
|---|---|---|---|
| `/` | Ridgeline Plumbing \| Boise Plumber for Homes and Shops | Ridgeline Plumbing \| Boise plumbers for homes and shops | ok |
| `/water-heater-repair` | Water Heater Repair and Replacement in Boise, Idaho \| Ridgeline Plumbing | Water heater repair in Boise \| Ridgeline Plumbing | ok |
| `/sewer-line-repair` | Sewer Line Repair, Camera Inspection and Trenchless Replacement \| Ridgeline Plumbing | Sewer line repair in Boise \| Ridgeline Plumbing | needs review |
| `/leak-detection` | Leak Detection & Repair \| Ridgeline Plumbing | Leak detection in Boise \| Ridgeline Plumbing | ok |
| `/emergency-plumbing` | 24/7 Emergency Plumber in Boise \| Ridgeline Plumbing | Emergency plumber in Boise \| Ridgeline Plumbing | has [ADD] |

The sewer row is marked `needs review` because its meta description uses a number that is not on the page or in the interview. Pit Crew does not publish a row that fails its checks. The emergency row needs a fact from you (a slot for your phone number) before it can be approved.

Pit Crew also writes `onpage.json` next to the workbook: every proposed change per page, with its status. It is written in a format [Caddie](https://github.com/timlaneseo-tech/unfayr-caddie)'s weekly check is designed to pick up. Caddie support for it is coming in a future Caddie release; Caddie does not read it yet.

## Try it in 90 seconds

No site, no accounts, no keys, nothing to publish. Sample mode runs the whole process on a fictional plumber (12 pages, bundled in the plugin) with no network.

1. Install the plugin (see [Install](#install)).
2. In Claude Code, type:

```
/pitcrew --sample ridgeline-plumbing.example
```

Claude crawls the sample site, loads the sample interview answers, uses pre-written rewrites bundled with the sample (so no copy is written live and there is no search step) and opens `Pit Crew - ridgeline-plumbing.example - <date>.xlsx`. Look at the Pages tab: three titles over the limit are fixed, six pages that shared one meta description now have their own, one page without an H1 has one, one row is flagged for review and one waits for a fact.

Working from a clone instead (`git clone https://github.com/timlaneseo-tech/unfayr-pit-crew`)? From the repo folder, `npm install` and then `npm run check` runs the same sample end to end and prints where the workbook went.

## Install

```
/plugin marketplace add timlaneseo-tech/unfayr-ref
/plugin install pitcrew@unfayr
```

The `unfayr` marketplace lists Pit Crew from this repository, https://github.com/timlaneseo-tech/unfayr-pit-crew.

Pit Crew needs Node 22.18 or newer (the LTS version from nodejs.org is fine). The first time it runs, Pit Crew installs its three runtime dependencies (exceljs, he and node-html-parser) with npm, skipping the development tools, so it needs a network connection once. [SETUP.md](SETUP.md) has the one-time steps for connecting a store or site so it can publish.

## Publishing and safety

- **It never publishes on its own.** Nothing leaves your machine until you approve rows in the workbook, read the dry run and say yes in the conversation. A yes to something earlier does not count.
- **Dry run first.** You see what will change, by page type and field, which rows will be skipped and why, and a few before and after examples.
- **Backup before every publish.** The live values are saved first. Every publish prints a rollback command.
- **Rollback restores only what Pit Crew applied.** Fields it never changed, and edits someone else made since, are left alone. If a field was empty before, rollback clears it again where the platform allows; anything it cannot clear is reported as not restorable and you clear it by hand.
- **If the live page changed after the crawl, Pit Crew skips it.** It compares the page as your site serves it with the workbook, and reads each record again just before writing. If someone edited it in the meantime, Pit Crew will not overwrite their edit.
- **H1 renaming is opt-in.** On Shopify a product title is the H1, and on WordPress a post title is the H1. Changing it renames the record in your cart, order emails and product feeds. Those H1 changes are skipped unless you explicitly say you want them.
- **Rows that fail the checks are never published.** That includes any row that still has an `[ADD: ...]` slot.

## Platform notes

- **Shopify.** Publishes the SEO title and description for products, collections, pages and articles, through a custom app token with the narrowest scopes that work.
- **WordPress.** Needs https and an application password. Yoast and Rank Math fields are often not writable over WordPress's REST API, so Pit Crew checks first and, when they are not, writes a CSV for your SEO plugin's own importer instead. It will not claim the import happened until you say it did.
- **Webflow.** Static page SEO and CMS items are written through the Webflow API. CMS changes stay staged until you click Publish in Webflow. Pit Crew never publishes the site for you.
- **Static sites and Git.** Pit Crew edits the files in your local clone and shows you the diff. Committing and deploying are separate yeses, and it never pushes.
- **Everything else (Wix, Squarespace and so on).** The workbook is the handoff. If your Claude session has a connector for the platform, Pit Crew can make the changes through it in batches of 10, each batch after its own yes, marked best effort because there is no API rollback.

## The never-invent rule

Every number, price, year, count, place, credential and guarantee in the copy has to be on that page or in your interview answers. Claim words are blocked unless your page or your answers already say the same thing: best, best-rated, top-rated, #1, number one, award-winning, certified, licensed, guaranteed, leading, trusted by, free, same-day, insured, bonded, warranty, money-back, lowest, cheapest, fastest and 24/7. A price you give in the interview is only used on product, collection, service and location pages. The same rule covers the Deep fixes suggestions: an opening, heading, FAQ or alt text that needs a fact Pit Crew does not have comes back as an `[ADD: ...]` slot. When good copy needs a fact Pit Crew does not have, it writes `[ADD: years in business]` instead of guessing, and the row cannot be approved until you fill it in. Lengths are checked too: titles 30 to 60 characters, meta descriptions 70 to 155. Every row's problems are listed in the workbook's Issues column. Four checks are warnings: a title wider than about 600 px, a title and H1 that say different things, a near-duplicate title or meta, and a past year. Warnings show in the workbook but do not block publishing; everything else does.

## Built on current guidance

Pit Crew's checks and writing rules follow Google's own documentation, checked on 2026-10-09:

- [Influencing your title links](https://developers.google.com/search/docs/appearance/title-link) (updated 2025-12-10): descriptive and concise titles, no keyword stuffing, no repeated or boilerplate titles, brand briefly at the start or end, and the main title clear in the first `<h1>`. Google builds title links from several places, including the `<title>`, the H1 and `og:title`, and rewrites out-of-date years.
- [Control your snippets](https://developers.google.com/search/docs/appearance/snippet) (updated 2026-04-20): meta descriptions have no length limit but are cut to the device width, should be unique per page, and read best as a factual summary of that page.
- [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features) (updated 2025-12-10): no special optimisation for AI Overviews or AI Mode; the SEO basics apply, key content stays in text and structured data matches the visible text.
- Google Search Central announced that FAQ rich results were deprecated and the documentation removed, so Pit Crew's FAQ suggestions are page content for readers and AI answers, never promised as rich results.

The pixel-width check follows from this. Google truncates titles by rendered width (roughly 600 px on desktop), not by character count, so Pit Crew estimates the width of each proposed title and flags the ones over 600 px. It also flags titles and H1s that say different things, near-identical metas (nearly the same words), and past years in a title or meta. When a page's `og:title` or `og:description` repeats the old title or meta, the Git adapter updates it too, and it never adds Open Graph tags that are not there. Pit Crew also respects your robots.txt, using the group that names `pitcrew` or else the `*` group. None of this promises rankings or AI citations.

## AI answers

No tool can guarantee that an AI answer cites your page, and Pit Crew does not promise it. It acts only on what current research supports, checked on 2026-10-09: "What Gets Cited: Competitive GEO in AI Answer Engines" (arXiv 2605.25517) finds topical relevance matters most, and an explicit price and a recent date help consistently, while formatting-only edits do little; "From Citation Selection to Citation Absorption" (arXiv 2604.25707) finds highly cited pages are rich in extractable evidence such as definitions, numbers, comparisons and steps; and "Optimizing Visibility in Generative Engines: A Critical Survey (2023-2026)" (arXiv 2607.14035) finds relevance is the most reproducible lever and that generic citation tricks transfer poorly and can hurt. So Pit Crew keeps titles, H1s and metas relevant and plain, puts a real price in the meta when your page shows one, and lists the plain facts worth stating on your top pages (price, service area, turnaround, a definition, a visible last-updated date) in a "For AI answers" column in the Deep fixes tab. Anything it cannot find on your page or in your interview becomes an [ADD] slot. It leaves out formatting tricks.

## Limits

- Up to 1,000 indexable pages per run. A larger site asks you which sections to include.
- A run uses your own Claude plan. The benchmark's writing step for 12 pages reported a cost of $0.13 at API prices; on a Claude plan that counts against your usage instead of being billed. That figure covers only the writing step, not the crawl, interview or search research, and it is one run. There is no other bill: no API, no subscription, no per-page fee.
- Pages that return an error, are not HTML, are set to noindex, point to another page with a canonical, are blocked by your robots.txt (the `pitcrew` group if there is one, otherwise the `*` group, never both; Allow, Disallow, `*` and `$` work, and if robots.txt returns a server error, 429 or no answer, Pit Crew tries three times and then stops with a message instead of crawling), or are pagination or query-string variants are left out of the run.

## Privacy

Everything runs on your machine, inside your own Claude Code session. There is no telemetry, no account and no hosted service. Pit Crew fetches only your own site's pages, with a user agent that says who it is, and reads search results for your top pages. Store and site credentials are saved in `%APPDATA%\pitcrew` (`~/.config/pitcrew` on macOS and Linux), outside the results folder, never printed and never put in chat.

## Benchmark

[evals/benchmarks/2026-10-pitcrew-v1.md](evals/benchmarks/2026-10-pitcrew-v1.md) compares Pit Crew with plain Claude on the same 12 page extracts, scored by Pit Crew's own rules. The line to quote, with its qualifier:

> In one fixture site of 12 pages (one run each, scored by Pit Crew's own lint), Pit Crew's rewrites had unsourced numbers or claims in 1 row, length failures in 0 and duplicates in 0, and 11/11 (100%) of titles matched the naming convention, against 1, 1, 0 and 9/11 (81.8%) for plain Claude.

The rules are Pit Crew's own and Pit Crew was told them, so this shows how well each follows that way of writing, not which is better in general. [evals/README.md](evals/README.md) explains how to run it yourself.

## License

Free to use for your own site and your clients' sites. Not to be sold, modified or rebranded. See [LICENSE](LICENSE) for the Pit Crew Free Use License. [CHANGELOG.md](CHANGELOG.md) lists what changed in each version.

Built by Unfayr · unfayr.com
