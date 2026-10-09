---
name: research
description: Use during a Pit Crew run, after the interview and the top-25 selection, to research the 25 most important pages. Proposes one target query per page for the owner to bulk-confirm, runs a web search for each, notes what the top results promise, their title patterns, People Also Ask questions and the facts competitors all mention, and saves research/<slug>.json for the writer. Uses Semrush only when its tools are present.
---

# Pit Crew research, top tier

Research runs on the top 25 pages only (`top.json`). Everything else is written from its own page and the interview. The goal is not keywords to stuff in. It is to know what a searcher expects to see, so the title and meta promise the right thing in the right words.

## 1. Read what you need

- `top.json` in the run folder: the 25 URLs. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" top --site <host>` first if it does not exist yet. Pass the site as a host or full address, never a value starting with `/` (on Windows, Git Bash rewrites an argument that starts with `/` into a folder path).
- `pages.json` for each page's current title, H1, H2s and intro.
- The saved interview (`interview.json`) for the brand, the places served and any proof.

## 2. Propose the target queries and confirm in bulk

For every top page propose one target query: the phrase a real searcher would type to find that page. Short, plain, in the searcher's words, and tied to the page's single topic (for example `water heater repair boise`, not `plumbing services`). Do not give two pages the same query. If two pages would compete for one query, say so and give the second a distinct angle.

Show **all 25 at once** as one table: page, current title, proposed query. Then ask one question: "Confirm these, or tell me which to change." Accept edits in any form ("change 4 to ...", a corrected table). Do not walk through them one by one. Do not search until the list is confirmed.

## 3. Search each one

Use WebSearch for each confirmed query (about 25 searches in all). For each, read the top results and note, in the searchers' terms:

- **What the top results promise.** The offer or answer in their titles and snippets (price, speed, free quote, guide, comparison).
- **Title patterns.** How the top titles are built and how long they are (for example `{Service} in {City} | {Brand}`, or a question followed by a promise).
- **People Also Ask questions.** The questions shown, copied as they appear. Skip this field when none show.
- **Facts competitors all mention.** Only what several results state in common (a warranty, a response time, free shipping). Mark each as a thing to check with the owner, not a thing the site can claim.

Rules for the notes:

- Note what searchers expect. Do not copy a competitor's wording.
- Competitors' facts are not the site's facts. A competitor's "licensed and insured" does not make the site licensed. The writer may only use a fact from this site's page or the interview, so keep competitor facts under their own heading and label them as context.
- Record in `notes` which concrete facts the top results state (price ranges, definitions, steps, comparisons), so the writer can see what an answer engine expects. Never copy competitor facts as this site's facts.
- Note the date of the search. Results change.

If a search fails or returns nothing useful, save the file with an empty `notes` and say so in `sources_used`. Do not make up what the results might have said.

## 4. Semrush, only if it is there

If the Semrush tools are present in this session (for example `keyword_research`), you may add search volume and intent for each confirmed query, and add `"semrush"` to `sources_used`. If the tools are not listed, do not mention Semrush and do not ask the user to connect it. Never state a volume you did not read from the tool.

## 5. Save one file per page

Write `research/<slug>.json` in the run folder (`Documents/Pit Crew/sites/<host>/runs/<date>/research/`), where `<slug>` is the page's `slug` from `pages.json`. Create the folder first. Each file has exactly this shape:

```json
{
  "query": "water heater repair boise",
  "sources_used": ["web search"],
  "notes": "Top results promise same-day repair and upfront quotes. Titles follow {Service} in {City} | {Brand}, 45 to 58 characters. People Also Ask: How much does it cost to replace a water heater? Competitor context (not claims for this site): most list a warranty."
}
```

`sources_used` lists what you really used: `"web search"`, and `"semrush"` only if its tools ran. `notes` is plain text, a few sentences, no HTML. If Semrush data was read, put the volume and intent in the notes.

When all 25 are saved, tell the owner in two lines what you found that will change their titles most (for example "Searchers for your top service expect a price or a quote in the result"), then hand back to the run for the write step.

Built by Unfayr · unfayr.com
