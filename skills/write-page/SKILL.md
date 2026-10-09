---
name: write-page
description: Use when asked to write the new title, meta description and H1 for the pages in one Pit Crew batch file (batches/NN.json), as a subagent or directly. Reads the batch, the interview inside it and, for top pages, research/<slug>.json, and writes batches/NN.out.json. Plain text only, facts only from the page text and the interview, [ADD: ...] for missing proof, one naming pattern, title 30 to 60 and meta 70 to 155 characters, one H1, a reason and sources for every row.
---

# Writing titles, metas and H1s for one batch

You are given a batch file path (`.../batches/NN.json`) and the `out` path to write (`.../batches/NN.out.json`). You write that one file and nothing else. Do not run the CLI, do not publish, do not touch other batches, do not ask the user questions. If something is unclear, make the safe choice (keep the current value, or use an `[ADD: ...]` slot) and explain it in the reason.

## Input

The batch file is `{ "pages": [...], "interview": {...} }`.

- Each page has `url`, `type`, current `title`, `meta`, `h1s`, `h2s`, `intro` (first 100 words), `text` (the page's main text), `cta` and more.
- `interview` has `brand`, `answers` (each `{ id, question, answer }`, `answer` may be null) and `convention` (separator, brand position, case, and one `patterns` entry per page type).
- For top-tier pages there is `research/<slug>.json` in the run folder, next to `batches/`: `{ query, sources_used, notes }`. Read it for those pages. A page is top-tier if its research file exists.

## The rules

These are enforced by a linter after you write. A row that breaks one comes back to you once, then is marked `needs review`. Write it right the first time. Four checks are warnings, not blocks: title pixel width, a title and H1 that say different things, a near-duplicate title or meta, and a past year. Warnings show in the workbook's Issues column but do not block publishing. Still avoid them.

1. **Plain text only.** No HTML and no entities. Write `&` and `'` and `é` as themselves, never `&amp;` or `&#39;`. No markdown, no quotes around the value, no line breaks.
2. **Facts only from the page text and the interview answers.** Every number, price, year, count, place, credential, guarantee and brand name in your copy must be visible in that page's `text` or `intro`, or in a non-null interview answer. Competitor facts from research notes are context for wording only, never facts for this site. If you cannot point to where a fact came from, leave it out.
3. **Missing proof becomes a slot.** If good copy needs a fact you do not have (a phone number, how many years, a price, a credential), write `[ADD: what is needed]` in its place, for example `[ADD: years in business]`. Never guess to fill it. A row with a slot cannot be approved until the owner fills it. Use a slot only where it makes a clear difference; do not litter every row with them.
4. **Claim words need a source.** `best`, `#1`, `award-winning`, `certified`, `licensed`, `guaranteed`, `leading`, `top-rated`, `trusted by`, `free`, `same-day`, `insured`, `bonded`, `warranty`, `money-back`, `lowest`, `cheapest`, `fastest`, `24/7` and similar are blocked unless the page text or an interview answer says the same thing. When in doubt, leave them out.
5. **Follow the convention.** Use `interview.convention.patterns[page type]` for the shape, `convention.separator` between the core and the brand, `convention.case` for capitalisation (sentence case: first word and proper nouns only), and the brand position rule. The brand is spelled exactly as in `interview.brand`.
   - Home page: the brand is always in the title.
   - Other pages: brand at the end. If the title with the brand would pass 60 characters, drop the brand.
6. **Lengths, counted in characters after decoding entities.** Title 30 to 60, including the brand. Meta 70 to 155. Count code points: an accented letter or an emoji is one character. Aim a little inside the limits (title 40 to 58, meta 120 to 155, so it survives mobile truncation and stays complete).
7. **One H1 per page.** `h1` is the one H1 you propose. Do not propose a second. If the page already has exactly one good H1, set `h1` to `null` (keep current). Do not make the H1 a copy of the title when a plainer heading serves the reader better; they should say the same thing in different words.
8. **Every meta is unique** on the site. Write each from that page's own content, not from a shared template. Do not write a meta that could be pasted onto another page.
9. **Titles are unique** too. Two pages must not share a title. If two pages are near-duplicates, separate them with what actually differs (place, size, model).
10. **Keep a good value.** If the current title, meta or H1 already meets the rules and the convention, set it to `null`. Do not rewrite for the sake of it. `null` means keep current and is not published as empty.
11. **Write for the searcher.** Lead with what the page is about, in the words a customer would use (the research query, for top pages). Say what they get and, where the page supports it, why this business. The meta ends with the call to action the interview or page supports. No stuffing, no repeated keywords, no filler like "high quality" or "great service".
    - **Title:** put the main entity (the service, product or topic) first. Aim for about 580 px or less, which is Google's cut-off width on desktop: avoid long runs of wide capitals, and keep to 30 to 60 characters as well. The H1 says the same thing as the title in plainer words. No years unless the page itself is about that year.
    - **Meta:** a factual, specific summary of this page: what it is, for whom, and the concrete facts that are on the page. For products: brand, key spec, and price or shipping and return facts if the page shows them. For articles: what the reader will learn, and the author if the page names one. For local services: the area served and how to book. No curiosity bait, no vague promotional language, no keyword lists.
12. **Reason line.** One sentence per row saying what changed and why, plain English. For example: "Shorter title in the {Service} in {City} pattern; unique meta replaces the shared one." If a slot is used, say what to add.
13. **Sources.** `sources` lists where the facts came from, from this set only: `"page"`, `"interview"`, `"search results"`. Use `"search results"` only when the research notes shaped the wording. Never invent another source name.
14. **Relevance first.** The title, H1 and meta state the page's main entity and the confirmed query's words, naturally. Never rewrite a clear, relevant title into a "citation-bait" one, and never use generic AI-SEO phrasing. Topical relevance is what the evidence says matters most.
15. **Price.** On product, collection and service pages: when the page shows a price, a starting price or a fee (or an interview answer gives one), put it in the meta, for example "From $89". Never invent one. If a price would clearly help and none exists, add `[ADD: starting price]` to `citationFacts` instead of putting a slot in the meta.
16. **`deep` is for top-tier pages only.** If the page has a research file, add a `deep` object. Pages without a research file get no `deep` key at all.

## Output

Write `NN.out.json` as a JSON array with one object per page in the batch, in order, covering every page:

```json
[
  {
    "url": "https://ridgeline-plumbing.example/water-heater-repair",
    "title": "Water heater repair in Boise | Ridgeline Plumbing",
    "meta": "Water heater repair and replacement in Boise, Idaho. Get an upfront quote and a plumber who arrives when scheduled. Call Ridgeline Plumbing.",
    "h1": "Water heater repair in Boise",
    "reason": "Shorter title in the {Service} in {City} pattern; unique meta replaces the shared one.",
    "sources": ["page", "interview"],
    "deep": {
      "query": "water heater repair boise",
      "intro": "Water heater repair and replacement for Boise homes.",
      "h2s": ["Signs your water heater needs repair", "Repair or replace"],
      "faq": [{ "q": "Do you give upfront quotes?", "a": "Yes. You get the price before the work starts." }],
      "schema": "LocalBusiness",
      "altFixes": ["Add alt text to the hero image describing the unit being repaired."],
      "citationFacts": ["Serving Boise since 1998", "[ADD: starting price for a water heater repair]", "[ADD: last-updated date shown on the page]"]
    }
  }
]
```

- `url`: copied exactly from the page.
- `title`, `meta`, `h1`: the new text, or `null` to keep current.
- `reason` and `sources`: required on every row.
- `deep` is present only for top-tier pages:
  - `query`: the confirmed target query from the research file.
  - `intro`: a 40 to 80 word answer-first opening for the page, facts from the page and interview only. It leads with a one-sentence definition or direct answer.
  - `h2s`: a suggested outline. Where the page supports it, include a steps section, a comparison, or a cost section.
  - `citationFacts`: 3 to 6 concrete, extractable facts the page should state plainly for AI answers, such as the price or starting price, service area, turnaround or response time, a definition, a key spec, and "Last updated <date>" visible on the page. Each is either taken from the page text or the interview, or written as an `[ADD: ...]` slot. The date is `[ADD: last-updated date shown on the page]` unless the page already shows one. Any entry with a number or claim word that is not on the page or in the interview must be an `[ADD: ...]` slot; the merge step converts it if you forget.
  - `faq`: question and answer pairs written as on-page content for readers and AI answers, only when the research notes list People Also Ask questions that justify them, otherwise `[]`. Answers must follow the same fact rules. Never promise FAQ rich results: Google retired that feature.
  - `schema`: the JSON-LD type that fits, as a short name, or an empty string. It must only describe content that is visible on the page. Prefer `Organization` or `LocalBusiness` plus `WebSite` (the site name) on the home page, `Service` or `LocalBusiness` on service and location pages, `Product` on product pages, `Article` or `BlogPosting` on articles, and `BreadcrumbList` where breadcrumbs are visible. Never suggest `FAQPage` for rich results. For articles, mention `dateModified` only when a visible date exists on the page; structured data must match the visible text.
  - `altFixes`: image alt-text suggestions where the page's alt coverage is poor, or `[]`.
  - Formatting-only advice (bold, emoji, bullet styling) is out of scope: it does not move citations. Say nothing about it.
  - The deep fixes are suggestions for the owner. They are never published.

Validate before you finish: the file is valid JSON, every page in the batch has exactly one object, no title or meta repeats inside the batch, every title and meta is inside its length range, and no value contains `&amp;`, `&#`, `<` or `>`. Then reply with one line: how many rows you wrote and how many contain a slot.

Built by Unfayr · unfayr.com
