# Pit Crew v1 benchmark: Pit Crew vs plain Claude

Date: 2026-10-09 · Runner: `evals/run.ts` · Scenarios: `evals/scenarios.json`

The Pit Crew arm read the write-page skill at commit `e0dac7a`.

## Headline

**In one fixture site of 12 pages (one run each, scored by Pit Crew's own lint), Pit Crew's rewrites had unsourced numbers or claims in 1 row, length failures in 0 and duplicates in 0, and 11/11 (100%) of titles matched the naming convention, against 1, 1, 0 and 9/11 (81.8%) for plain Claude.**

Quote only that sentence, with its qualifier. The convention, sources and length checks are Pit Crew's own rules, so this measures how well each arm follows Pit Crew's way of writing, not general quality.

## Fixture: ridgeline (ridgeline-plumbing.example, 12 pages)

| Metric | Pit Crew | Plain Claude |
|---|---|---|
| Pages covered | 12/12 | 12/12 |
| Rows with an unsourced number or claim | 1/12 (issues: 1) | 1/12 (issues: 1) |
| Rows with a title or meta length failure | 0/12 | 1/12 |
| Rows with a duplicate title or meta | 0/12 | 0/12 |
| Convention match (title after the run) | 11/11 (100%) | 9/11 (81.8%) |
| Rows using an [ADD] slot for a missing fact | 0/12 | 0/12 |
| Rows with an invented fact and no [ADD] slot | 1/12 | 1/12 |
| Rows Pit Crew would mark needs review | 1/12 | 3/12 |

Counts are rows (pages) unless stated. Convention match is out of 11 because 1 page is of a type with no pattern in the naming convention (other). No row in either arm used an [ADD] slot, so the [ADD] rows say nothing about slot honesty here.

- Pit Crew: model claude-sonnet-5-5, 46 s, reported cost $0.13.
- Plain Claude: model claude-sonnet-5-5, 11 s, reported cost $0.06.

## Method

- Both arms: `claude -p --model sonnet --output-format json --tools "" --setting-sources project,local --strict-mcp-config --no-session-persistence`, prompt on stdin, run in an empty temp folder. No tools, no skills, no MCP servers, so each arm answers from the prompt alone.
- Pit Crew arm: the `write-page` skill instructions, then the batch file (the page extracts plus the interview) and the instruction to reply with the contents of the output file.
- Plain arm: "Rewrite the titles, metas and H1s for these pages." and the same page extracts as JSON. It does not get the interview.
- Scoring: each reply is parsed as a JSON array, merged and linted by `mergeBatches` (the code the product runs, which also decodes entities and treats a value equal to the current one as "keep"), then counted by `evals/run.ts`. Convention match uses the title the page would have after the run, so a kept title that does not follow the pattern counts as a miss. A row with an invented fact and no [ADD] slot is a row with an unsourced number or claim and no slot.

## Caveats

- One run per arm, so the numbers move from run to run.
- The site is a fictional fixture built alongside Pit Crew, with long titles and shared metas on purpose.
- The lint is Pit Crew's own and Pit Crew's instructions encode it, so Pit Crew is expected to do well on it. The plain arm was not told the rules.
- The plain arm was not given the interview, which is part of the product. The lint still accepts facts found in the interview answers.
- Convention match is only counted for page types that have a pattern in the naming convention.
- No row in either arm used an [ADD] slot, so this benchmark does not test slot honesty.
- No real-site arm is part of this result.

Built by Unfayr · unfayr.com
