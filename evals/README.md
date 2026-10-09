# Pit Crew benchmark.

`run.ts` compares Pit Crew with plain Claude on the same page extracts.

```
node evals/run.ts
```

It sets up the ridgeline fixture in a temporary results folder (crawl, interview, batch), then runs `claude -p` headless twice, one run per arm:

- **Pit Crew:** the `write-page` skill instructions, the batch file (12 page extracts and the interview), and a request to reply with the output JSON.
- **Plain Claude:** "Rewrite the titles, metas and H1s for these pages." with the same page extracts as JSON, and nothing else.

Both runs use `--model sonnet --tools "" --setting-sources project,local --strict-mcp-config --no-session-persistence` in an empty temporary folder, so neither arm has skills, tools or MCP servers. Each reply is parsed as a JSON array, merged and linted with the same code the product uses (`lintAll`, through `mergeBatches`), and counted:

- rows with an unsourced number or claim
- rows with a title or meta length failure
- rows with a duplicate title or meta
- convention match rate (the title the page would have after the run)
- `[ADD]` honesty: rows that use a slot, and rows with an invented fact and no slot

The result is written to `benchmarks/2026-10-pitcrew-v1.md`. Only the qualified line under Headline may be quoted. Running it again overwrites that file and the numbers will move, because each arm gets a single run.

Useful options:

- `--dry` prints both prompts and runs nothing.
- `--model <alias>` changes the model.
- `--site example.com --answers answers.json` adds one real site (its first 25 pages) as a second scenario. `answers.json` is an interview file shaped like `fixtures/ridgeline-plumbing.example/answers.json`. The site is only read. Nothing is published.

Scenarios live in `scenarios.json`. Each run costs a few cents of your own Claude plan.

## Caveats.

The checks are Pit Crew's own rules and Pit Crew's instructions encode them, so this measures how well each arm follows Pit Crew's way of writing. The plain arm is not given the interview. The fixture is fictional and was built with problems on purpose.

Built by Unfayr · unfayr.com
