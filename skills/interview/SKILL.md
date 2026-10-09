---
name: interview
description: Use during a Pit Crew run, after the crawl and before any writing, to learn the facts only the owner knows and to fix the site's naming style. Asks at most 5 business questions (one per message, each skippable, only what the crawl could not answer), then a naming-style pick shown on three real pages, and saves everything with interview-save. On a rerun it shows the saved answers and asks "Still true?".
---

# The Pit Crew interview

The interview is the part no title-tag tool does. The owner knows things the pages do not say: how long they have been going, which towns they serve, what buyers check. Pit Crew may use only those facts, so every answer you save here becomes a fact the writer is allowed to use, and every gap becomes an `[ADD: ...]` slot.

Keep it light. They are busy and this is meant to take about two minutes.

## Before you ask anything

1. Read the saved interview if there is one: `Documents/Pit Crew/sites/<host>/interview.json` (or under `PITCREW_HOME`).
2. Run the naming analysis. It reads the crawl and returns the current patterns plus three ready-made candidates:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" conventions --site <host>
```

Read `brand` (a guess from the domain), `analysis` (separators in use, brand first or last or missing, title case vs sentence case, length spread) and `candidates` (three complete conventions). If the brand guess looks wrong, say the real name in the first message and correct it.

## A rerun: "Still true?"

If `interview.json` exists, show the saved answers as a short list (question and answer, skipped ones marked as skipped) and the saved naming style as one line plus one example. Then ask exactly: "Still true?" Three outcomes:

- **Yes.** Do not ask anything again. Skip to saving (nothing to change) and tell the run to continue. The saved interview is already in place, so `interview-save` is not needed.
- **Some of it changed.** Ask only about the answers they name, one per message, then run the save step below with the updated file.
- **New page types appeared** since the last run (for example the site now has products and the saved interview only covers services). Ask the bank questions for those types only, within the same limit of 5.

## The business questions

Rules, and they hold without exception:

- **At most 5 questions in total**, across all page types.
- **One question per message.** Wait for the answer.
- **Every question is skippable.** Say so in the first message: "Say skip to pass on any of these." A skip is saved as `answer: null`, never as an empty string, and never asked again in this run.
- **Only ask what the crawl could not answer.** Before each question, check the page text in `pages.json` for the answer (a phone number in the footer, "since 1998" on the about page, towns listed on the services page). If the pages already say it, do not ask. You may record the page's answer as the answer, with the question as asked, and do not count it as one of the 5.
- **Plain questions, no jargon.** Do not mention title tags in the questions.
- **Ask what matters most first**: the question bank lists them in priority order.

Use `references/question-bank.md` (`${CLAUDE_PLUGIN_ROOT}/skills/interview/references/question-bank.md`). Look at the page types present in the crawl (the readout and `analysis` tell you), take the `All sites` section first, then the sections for the types that make up most of the site. Pick the highest-priority questions the crawl cannot answer, up to 5.

Good answers are short and factual. If an answer is vague ("we are the best"), ask once for something specific that a customer could check, or save it as a skip. Do not save claims you could not put in a title without a source.

## The naming style

After the business questions, say: "Last one. Every page title on your site should follow one style. Here are three. Pick one, or tell me what to change."

Take the three `candidates` from `conventions`. For each, show it applied to **three real pages** from the site, chosen to cover different page types where possible. Build each example title from the real page: the page's own topic plus the candidate's separator, case and brand rule. Use the candidate's `patterns` for the page type. The brand always appears in the home title and, like everywhere else, goes at the end. On other pages it goes at the end and is dropped when the title would pass 60 characters. Keep every example within 30 to 60 characters, and show the length.

Present them like this, as a short block each:

> **Style A.** Pipe, sentence case, brand at the end when it fits.
> - Home: Boise plumbers for homes and shops | Ridgeline Plumbing (55)
> - Water heater repair in Boise | Ridgeline Plumbing (49)
> - How to shut off your main water valve: Know where it is (55, article pattern Topic: Promise, brand dropped because it would pass 60)

Every example must follow its own style exactly: the stated separator, case and brand rule (the brand at the end, on the home page too), the page type's pattern, and the real character count (code points, computed, not estimated).

Also show per page type the pattern in plain words (service: Service in City, product: Product and key spec, article: Topic: Promise). Tell them what the site uses now in one line, from `analysis`.

They can pick A, B or C, or edit one ("A, but with a dash, and Title Case"). If they edit, update the convention, show the three examples again for the edited version and ask for a yes. Their choice becomes the `convention` object: `separator` (`|`, `–` or `:`), `brand`, `brandPosition` (`end` or `end-if-fits`), `case` (`title` or `sentence`) and `patterns` (page type to pattern). Use one of the three candidates as the base and change only what they asked.

## Save it

Write a temp JSON file (in the scratchpad or system temp folder, not in the results folder) shaped like this, with the ids from the question bank:

```json
{
  "brand": "Ridgeline Plumbing",
  "answers": [
    { "id": "years", "question": "How long have you been going?", "answer": "Serving Boise since 1998" },
    { "id": "phone", "question": "Phone number to show?", "answer": null },
    { "id": "price", "question": "Is there a starting price or typical price range you're happy to show?", "answer": "Drain cleaning from $89", "appliesTo": ["product", "collection", "service", "location"] }
  ],
  "convention": {
    "separator": "|", "brand": "Ridgeline Plumbing", "brandPosition": "end-if-fits", "case": "sentence",
    "patterns": { "service": "{Service} in {City}", "article": "{Topic}: {Promise}" }
  }
}
```

Then:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" interview-save --site <host> --file <path to that JSON>
```

Save the `price` answer with `"appliesTo": ["product", "collection", "service", "location"]`, as in the example, so a price is only used on the pages it is about and never on an article or the home page. Any other answer may carry `appliesTo` (a list of page types: home, service, location, product, collection, article, other) when it is true only for those pages; leave it out when the answer holds for the whole site.

The brand is spelled exactly as the owner spells it, and lint enforces that spelling. If the command returns an `error`, it names what is wrong with the file; fix it and run it again. Tell them in one line what is saved: "Saved. I will use these answers and nothing else beyond what your pages say." Then hand back to the run.

Built by Unfayr · unfayr.com
