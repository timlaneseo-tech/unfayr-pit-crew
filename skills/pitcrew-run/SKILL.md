---
name: pitcrew-run
description: Use when someone asks to run their site through Pit Crew, e.g. "run my site example.com through Pit Crew", "pit crew my site", "rewrite all my titles and meta descriptions", or types /pitcrew <site>. Crawls the site, reads the pages, interviews the owner, researches the top pages, writes a new title, meta description and H1 for every page in one naming style, lints them, opens one Excel workbook, and offers to publish the approved rows.
---

# Running the whole Pit Crew process

This is the `/pitcrew <site>` run. If they did not name a site, ask once ("Which site? The address is enough, like example.com.") before anything else.

Every script call looks like `node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" <subcommand> ...`, prints JSON, and saves its results under `Documents/Pit Crew/sites/<host>/runs/<date>/`. The run resumes from what is saved, so an interrupted run is never started again from nothing. If they ask to carry on with a run, or a run for this site already exists from today, start at the Resume section at the end instead of step 1.

## Rules that hold all the way through

1. **Never invent.** Every number, credential, price, location or claim in new copy comes from the page text or the owner's interview answers. A gap becomes a visible `[ADD: ...]` slot.
2. **Never publish on your own.** Publishing is offered at the end and runs only through the `publish` skill, after a dry run and an explicit yes.
3. **Show the work.** Every change has a one-line reason and its sources.
4. **Plain talk.** Short messages, one step at a time. No JSON, no stack traces. Sentence-case headlines ending with a full stop, no exclamation marks.
5. **Never put credentials in chat.**

Say at the start: "Running Pit Crew on <site>. I will read your pages, ask you a few questions, and hand back one workbook. Nothing changes on your site unless you say yes at the end."

## Step 1. Crawl

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" crawl --site <site>
```

Progress line first: "Reading your sitemap and pages..." For a practice run use `--sample <fixture>` instead of `--site`.

- If it returns an `error` (no pages found, sitemap missing, everything noindex), pass the message on in plain words and stop. Do not build an empty workbook.
- If `capped` is true and there is no `truncatedTo`, the site has more than 1,000 indexable pages. Show `sections` as a short table (path section and page count), ask which sections to include (up to 1,000 pages in all), and run the crawl again with their sections as names without slashes, comma separated, for example `--include collections,pages`; the homepage is listed as `home` and is picked with `--include home,collections` (on Windows, Git Bash rewrites an argument that starts with `/` into a folder path).
- If the output has `truncatedTo`, the sections they picked still held more than 1,000 pages and Pit Crew kept the first 1,000. Do not ask for sections again. Tell them `message` in one line (for example "Kept the first 1,000 of 1,240 pages in /products/.") and ask whether to carry on with those pages. On a yes, go on to step 2. If they would rather narrow it, run the crawl again with fewer sections. If they want every page, do the section in parts: finish this run, then crawl again with the same `--include`, `--offset 1000` and a new `--date` label such as `<date>-part-2` (a label that starts with the date), and run steps 2 to 10 on that run too.
- If the output has `warnings`, an `--include` section matched no page. Say which in one line and offer to crawl again with the right section names.
- If the output has `cleared`, this crawl found different pages from an earlier crawl today, so the saved top pages, batches and proposals were cleared. Say so in one line; the steps below rebuild them.
- Note `host` and `date` from the output. Pass `--site <host>` on every later call. Add `--date <date>` only if a newer run exists for this site than the one you are working on (otherwise the latest run is used).

## Step 2. Extract

The crawl already extracted each page: title, meta description, H1s, H2s, the first 100 words, JSON-LD types, image alt coverage, the main call to action and the page type (`home`, `service`, `location`, `product`, `collection`, `article`, `other`). There is nothing to run. Tell them the page-type mix in one line, for example "42 products, 6 collections, 9 articles, 5 other pages."

## Step 3. Platform

`platform` in the crawl output is Shopify, WordPress, Webflow, Wix, Squarespace or unknown. Keep it for step 10. Say it in one line. If it is `unknown`, `wix` or `squarespace`, do not guess; step 10 explains the options.

## Step 4. Site readout

Show the `readout` as a short table, numbers only: pages scanned, titles over 60 characters, duplicate titles, duplicate metas, missing H1s, pages sharing one boilerplate meta, and the naming patterns in use. One sentence under it on the biggest problem. Do not explain every number.

## Step 5. Interview

Load the `interview` skill (`pitcrew:interview`; on a plain skills install read `${CLAUDE_PLUGIN_ROOT}/skills/interview/SKILL.md`) and follow it. It asks at most 5 business questions, one at a time, then the naming-style pick, and saves the result with `interview-save`. On a later run it shows the saved answers and asks "Still true?".

Do not continue until an interview is saved. That means `interview-save` succeeded, or, on a rerun, the owner answered "Still true?" with yes and the saved interview stands (no `interview-save` needed). Nothing below works without a saved interview.

**Sample mode** does not interview. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" interview-save --site <fixture> --file "${CLAUDE_PLUGIN_ROOT}/fixtures/<fixture>/answers.json"` and go on. Skip step 6 (research) entirely, with no WebSearch. Run `top` (no `--clicks`) and `batches` as usual, then use no writer subagents: in step 8 run `merge --sample-outs`.

## Step 6. Research

First pick the top 25 pages. If the Search Console tools are available (the `search-console` MCP: `list_sites`, then `search_analytics`), pull the last 90 days of clicks by page for this site. Write them to a temp file `clicks.json` as a list of `{ "url": "...", "clicks": 123 }` and run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" top --site <host> --clicks <path to clicks.json>
```

Without Search Console, run `top` with no `--clicks`; it ranks by the homepage, the nav-linked pages, then internal links. Either way the 25 URLs are saved to `top.json`. If the Search Console tools are present but the site is not in `list_sites`, skip clicks and say so in one line.

Then load the `research` skill (`pitcrew:research`; plain install: `${CLAUDE_PLUGIN_ROOT}/skills/research/SKILL.md`) and follow it: confirm one target query per top page in bulk, search for each, and save `research/<slug>.json`.

## Step 7. Write

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" batches --site <host>
```

This writes `batches/NN.json` (25 pages each, the top 25 first, with the interview inside) and lists `pending` batches with the `file` to read and the `out` file to write. Batches that already have an `NN.out.json` are not listed, which is how a resumed run skips finished work.

Dispatch one subagent per pending batch, at most 4 running at once. Each subagent gets:

- the batch file path and the `out` path it must write
- the research folder path (`research/<slug>.json` exists for top pages only)
- the instruction to load the `write-page` skill (`pitcrew:write-page`; plain install: `${CLAUDE_PLUGIN_ROOT}/skills/write-page/SKILL.md`) and follow it exactly

Wait for a group to finish before starting the next. Progress line: "Writing 25 pages at a time, 4 batches at once..." If a subagent fails or writes no `out` file, run `batches` again later; it lists only what is still pending. In sample mode there are no writer subagents; see step 5.

## Step 8. Lint

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" merge --site <host>
```

`merge` reads every `NN.out.json`, lints each proposal (lengths, one H1, duplicates, the naming pattern, unsourced numbers and claims, `[ADD]` slots, brand spelling) and saves `proposals.json`. Read the output:

- `counts` has the totals by status: `ok`, `needs review`, `has [ADD]`.
- `retry` lists URLs that need another pass (`needs review` rows plus pages in batches that never came back). Retry once, and be exact about files, because `merge` keeps the first entry it finds for a URL (batches read in order of id), so a new extra out file such as `99.out.json` would be ignored:
  1. For each `needs review` URL, read its issues from `proposals.json`. Dispatch a writer (the `write-page` skill, same rules) with that page, its batch's interview and the lint messages, and have it produce one replacement entry for the URL.
  2. Open the URL's original `batches/NN.out.json`, remove the old entry for that URL, and put the replacement entry in its place. Keep the file a valid JSON array with one entry per page.
  3. For pages in a batch that never came back (`missingBatches`), run `batches` and dispatch that batch again to write its own `NN.out.json`.
  4. Run `merge` again. Do this once only. Whatever still fails stays `needs review` with its reason and is never auto-approved.
- `missingBatches`, `duplicates`, `unknown` and `pagesWithoutProposal` should be empty. If not, run `batches` again and dispatch what is pending.

Never loosen a rule to make a row pass.

## Step 9. Workbook

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" workbook --site <host>
```

It writes `Pit Crew - <host> - <date>.xlsx` and `onpage.json` (the Caddie handoff) and opens the workbook. Then finish this step with five lines, no more:

1. "Your Pit Crew workbook is open." (or its path if it did not open)
2. The counts: pages changed, rows `ok`, rows `needs review`, rows with an `[ADD]` slot.
3. What to do: "In the Pages tab, type Y in the Approve column for every row you want. Edit any new wording you like; your wording wins. Fill the [ADD] slots before approving those rows. Save the file."
4. Where things are: the run folder, and the Deep fixes tab (intro, H2s, FAQ and schema ideas for the top pages; reference only, never published).
5. "Tell me when you have saved it."

## Step 10. Offer to publish

Offer only when there is a route:

| Platform | Route |
|---|---|
| Shopify, WordPress, Webflow | Direct publishing with an API token. |
| A local site folder (static, Git) | Edit the files and show `git diff`. |
| Anything else | Assist mode (a connector, an MCP or Claude in Chrome that can reach the admin), in batches of 10, labelled best effort. |
| No route at all | Name the workbook as the handoff file, plus a CSV if the platform imports one (`wp-csv` for WordPress SEO plugins). |

Say it once, plainly: "When you have approved the rows you want, say publish and I will show you exactly what would change before anything goes live." Do not push it. If they say publish, load the `publish` skill (`pitcrew:publish`; plain install: `${CLAUDE_PLUGIN_ROOT}/skills/publish/SKILL.md`) and start there. Without a route, say which handoff file to use and stop.

## Resume

When they want to carry on with a run, or a run for this site already exists from today, ask where it got to instead of crawling again:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" status --site <host>
```

Add `--date <date>` only if a newer run exists than the one they mean. `stage` is how far the run got, and `next` says what comes next:

| `stage` | Start at |
|---|---|
| `none` | Step 1 (crawl). |
| `crawled` | Step 5 (interview). |
| `interviewed` | Step 5's "Still true?" if not confirmed this session, then step 6 (research). |
| `top` | Step 7 (write): run `batches`. |
| `batches pending N` | Step 7: run `batches` and write only the pending ones. With 0 pending, step 8. |
| `merged` | Step 9 (workbook). |
| `workbook` | Ask whether they have approved rows; if so, offer step 10. |
| `published` | Done. Remind them of the rollback command if they need it. |

Say in one line where you are picking up, for example "Picking up where we left off: 2 batches still to write." Batches whose pages changed since they were written are rewritten automatically: `batches` lists them as pending again.

- A later run for the same site shows the saved interview and asks "Still true?" instead of asking again.

Built by Unfayr · unfayr.com
