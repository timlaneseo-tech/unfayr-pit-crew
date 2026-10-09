---
name: publish
description: Use when someone wants to publish their approved Pit Crew changes ("publish", "push these live", "apply the approved rows"), or roll a publish back ("rollback", "undo the publish", "restore the old titles"), e.g. /pitcrew publish example.com or /pitcrew rollback example.com <backup-id>. Reads the workbook approvals, takes a backup, shows a dry run, publishes only after an explicit yes, verifies the live pages, and reports the rollback command. Covers Shopify, WordPress, Webflow, Git or static sites and assist mode.
---

# Publishing approved Pit Crew changes

Publishing changes a live site, so the rules here are strict and they do not bend.

## The rules

1. **Never publish without an explicit yes** in this conversation, given after you showed the dry run. "Looks good", silence, or a yes to something earlier is not a yes. If the answer is unclear, ask again in one line.
2. **Always the same order:** approvals, then `publish-plan` (which takes the backup and does not change the site), then the dry run, then the explicit yes, then `publish-apply`.
3. **Never pass `--include-renaming-h1`** unless they explicitly opt in after you showed the warning below. By default, H1 changes that would also rename a product, post or page record are skipped.
4. **Never put credential values in chat.** Do not print a token, password or key, do not repeat one back, and do not quote a file that holds one.
5. **Never commit, push or deploy without its own explicit yes**, one yes per action. Never run a site-wide publish (such as Webflow's) at all. Pit Crew only offers these where listed below.
6. Plain talk. No JSON, no stack traces. Sentence-case headlines ending with a full stop, no exclamation marks.

## Step 1. Read the approvals

Ask them to save the workbook if it is open, then:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" approvals --site <host>
```

This reads the Approve column (Y, yes and similar count as yes), takes their edited wording as the final wording, re-lints every row and saves the result. Report in two lines: how many rows are approved, rejected, undecided. If `approvedNeedingReview` is not empty, say those rows will be skipped (a row that fails lint or still has an `[ADD]` slot is never published) and why in one line each for the first few. If `unknownUrls` or `duplicateUrls` are not empty, say so; those rows are ignored.

If nothing is approved, stop and tell them how to approve rows in the Pages tab.

## Step 2. Pick the route and get access

Use the platform from the crawl (`crawl.json` in the run folder). Direct routes: `shopify`, `wordpress`, `webflow`, `git`. If no credentials are saved for this host and platform yet, the first `publish-plan` will say so; get them as below, then run it again.

### Saving credentials, for every platform

The secret never passes through chat. Ask them to create the token (steps below), then:

1. Create a temp JSON file in the system temp folder (or the `tmp` folder inside the Pit Crew config folder), never in the results folder, at a named path, with placeholder values only, for example `"token": "PASTE-TOKEN-HERE"`. `credentials-save` deletes the file afterwards only when it is in one of those two folders, so do not put it anywhere else.
2. Tell them the path, and ask them to open that file, paste the real values over the placeholders themselves, save it, and say "done".
3. Do not read the file after they edit it, and never restate, quote or echo any secret value. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" credentials-save --site <host> --platform <platform> --file <that file>`. It stores the values in the Pit Crew config folder, keyed by site, and deletes the temp file.
4. Reply only "Saved." If it returns an error saying the file is not valid JSON, it names the line and character and keeps the file: tell them that line and character, ask them to fix it there (usually a missing comma or quote) and say "done", then run it again. Do not open the file yourself.

The file shapes, one per platform:

- Shopify: `{ "shop": "your-store.myshopify.com", "token": "..." }`
- WordPress: `{ "base": "https://example.com", "user": "...", "appPassword": "..." }`
- Webflow: `{ "token": "...", "siteId": "...", "cmsFields": { "<collectionId>": { "title": "<field slug>", "meta": "<field slug>" } } }` (`cmsFields` only if the site has CMS pages)
- Git: `{ "repoDir": "C:/path/to/the/site/folder", "origin": "https://example.com" }`

### Shopify

Ask for a custom app token with the least access that works.

1. In Shopify admin: Settings, then Apps and sales channels, then Develop apps. If it says custom app development is off, click Allow custom app development.
2. Click Create an app. Name it Pit Crew.
3. Click Configure Admin API scopes. Tick `write_products`, `write_content` and `write_online_store_pages`. Tick the matching read scopes too: `read_products`, `read_content` and `read_online_store_pages`. Nothing else.
4. Save, click Install app, then reveal the Admin API access token once and copy it. Shopify shows it only once.
5. Also note the store's `.myshopify.com` address.

Shopify publishes the SEO title and description for products, collections, pages and articles.

### WordPress

1. The site must be on https. Application passwords do not work on plain http.
2. Sign in to WordPress as an administrator or editor. Go to Users, then Profile, scroll to Application Passwords.
3. Type the name Pit Crew and click Add New Application Password. Copy the password it shows (it has spaces; keep them).
4. They also need their username.

Expect that the SEO plugin's fields are often not writable over the REST API. `publish-plan` reports `seoPlugin` (Yoast, Rank Math or none), `metaWritable` and `metaWritableByKind`. If `metaWritable` is false, say plainly: "WordPress does not let me write your SEO plugin's titles and descriptions from outside. The reliable way is the plugin's own CSV import." Then:

- Both the SEO titles and the SEO descriptions go through the CSV, not through plan and apply. Do not offer plan-and-apply for those fields. The only thing REST could write is the post or page title, which is the H1 and renames the record (see the H1 warning below), so it stays off by default.
- Pit Crew compares the page as it is served, not the plugin's stored keys, so unreadable plugin keys do not cause `live-changed` skips on their own. A `live-changed` row still means the live page differs from the workbook.
- If `metaWritableByKind` is mixed (for example pages writable, posts not), run `publish-plan` with `--kinds` set to the writable kind, and use the CSV for the rest.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" wp-csv --site <host>
```

It writes `wordpress-import.csv` in the run folder from the approved rows. Tell them where it is and how to import it in their SEO plugin (Yoast and Rank Math both have an importer, or a CSV tool in their bulk editor). Do not claim it is imported until they say it is. If `metaWritable` is true, the normal plan and apply route works.

### Webflow

1. In Webflow: open the site, then Site settings, then Apps and integrations, then Generate API token.
2. Name it Pit Crew and give it read and write access to Pages and CMS only. Nothing else.
3. Copy the token. Also copy the site ID (Site settings, near the bottom of General).
4. **CMS collections.** For collection pages (blog posts, products, anything from the CMS) ask once which CMS fields hold the SEO title and the SEO description in each collection (the field names or slugs from the collection's settings). Save them as `cmsFields` in the credentials file. Static pages need no mapping.

Tell them two things before publishing, in plain words:

- CMS item edits are saved to Webflow as staged. They go live only when the user publishes the site in Webflow.
- Static page SEO goes live per Webflow's own behaviour. Either way, after Pit Crew finishes, they need to click Publish in Webflow to push everything out. Pit Crew never calls Webflow's site publish. So after `publish-apply`, the verification will show `pending` for these pages until they publish the site in Webflow; say so, and suggest checking again afterwards.

### Git or static site

Ask for the folder of the site's files (a local clone) and the public address. The crawl never detects Git, so always pass `--platform git` to `publish-plan`. After `publish-apply` you will show the exact change with `git diff` in that folder. Commit and deploy are separate yeses and Pit Crew never runs them without one (see below).

### Any other platform: assist mode

Wix, Squarespace and the rest have no direct route. If this session has a connector or MCP for the platform, or Claude in Chrome can reach its admin, offer to make the changes by driving it. Label it **best effort**: there is no API rollback, and the workbook's current columns are the record of the prior values. The same rules apply as for the API routes:

1. Run `approvals` first (step 1) and use only the approved rows whose status is `ok`. Never touch a row that is unapproved, `needs review` or `has [ADD]`.
2. Work in batches of 10. For each batch, show a table of page, field, current value and new value (current to new), and wait for an explicit yes for that batch before touching the admin. A yes to one batch is not a yes to the next.
3. Make the batch's changes, and read each page back where you can.
4. After each batch, report what changed and what failed, then `mark` each change. Mark with:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" mark --site <host> --url <full page address> --field <title|meta|h1> --status published
```

Pass the page's full address (https://...), never a path such as `/pages/about`: on Windows, Git Bash rewrites an argument that starts with `/` into a folder path. Use `verified` instead of `published` only after you re-read the live page and saw the new value. With no route at all, name the workbook as the handoff file, mention `wp-csv` if the platform imports a CSV, and stop.

## Step 3. Dry run

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" publish-plan --site <host>
```

Add `--platform <platform>` if the crawl could not tell, and always `--platform git` for the Git route. This takes a backup of the current live values (snapshot first) and plans the changes. It does not change the site. Show the dry run as a table:

| Kind | Title | Meta | H1 | Total |
|---|---|---|---|---|

with one cell per kind and field. Tally the cells yourself from the `preview` entries (count the entries for each kind and field pair); do not build the grid from `byKind` and `byField`, which cannot be crossed. Then the skipped rows grouped by `skippedByReason`, with the reason in plain words:

- `unresolved`: the page could not be matched to a record on the platform.
- `live-changed`: the live value is no longer what the workbook's current column says, so someone changed it after the crawl; Pit Crew will not overwrite it.
- `renames-record`: an H1 change that would rename the record (see below).
- `lint`: the row did not pass the checks or still has an `[ADD]` slot.
- `empty-value`, `duplicate-target`: nothing to write, or two rows point at the same record.

- `live-unreadable`: Pit Crew could not load the live page to check it, so it will not touch that row. Try again later.
- `unsupported`: the platform has no field Pit Crew can write for it (for example the H1 on Webflow).
- `no-access`: the saved credentials are not allowed to read that kind of page, so Pit Crew skipped those pages and planned the rest. Each skip carries a `message`, and `warnings` has one line per problem with the count, such as "3 pages skipped: The app can't read Shopify pages: add the read_online_store_pages scope (read_content on older apps) ...". Pass that line on in plain words and the fix it names: on Shopify, open the custom app's Admin API scopes, tick the missing read and write scopes (`read_online_store_pages` and `write_online_store_pages`, or `read_content` and `write_content` on older apps, for pages and blog posts; `read_products` and `write_products` for products and collections), save, reinstall the app, and run `publish-plan` again. On WordPress the user needs a role that can edit those pages or posts; on Webflow the token needs the `pages:read` or `cms:read` scope it names. If the credentials can read none of the approved pages, `publish-plan` returns an error with the same fix instead.

List the first few skipped URLs under each reason. Show 3 to 5 example changes from `preview` (current to new). Name the `backupId`.

Also report `excluded` (approved rows that did not pass the checks, with their status; they are never published or exported), `excludedByKinds` if present and any WordPress `metaWritable` problem from step 2.

### H1 changes that rename a record

On Shopify a product title is the H1, and on WordPress a post or page title is its H1. Changing it also renames the record everywhere it appears. If any rows were skipped as `renames-record`, say it exactly like this, with the real count:

> This also renames N products or posts in the cart, in order emails and in product feeds. They are skipped unless you opt in.

Do not use `--include-renaming-h1` unless they say, after reading that, that they want the H1s renamed. If they do, run `publish-plan` again with `--include-renaming-h1` and show the dry run again. When the H1 is its own field (a theme section or a static file), it publishes normally and no warning is needed.

## Step 4. The explicit yes

Ask one plain question: "Publish these N changes to <site>? Say yes to publish them all, or tell me what to leave out." Wait. Then:

- **An explicit yes** (yes, publish it, go ahead): continue to step 5.
- **A partial yes**: "products only", "just the pages", "skip the articles". Run `publish-plan` again with `--kinds` set to the kinds they named (for example `--kinds product`, or `--kinds product,collection`), which makes a new plan and a new backup id. If they already opted in to `--include-renaming-h1`, pass it again on the re-plan. Show the new dry run and ask for the yes again on that plan. The kinds you can name are the ones in `byKind` (Shopify: `product`, `collection`, `page`, `article`; Webflow: `page`, `cms-item`; WordPress: `page`, `post`; Git: `file`).
- **Anything else** (a question, "maybe", "not yet"): answer, and do not publish.

## Step 5. Apply and report

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" publish-apply --site <host> --backup <backupId>
```

Use the backup id of the plan they said yes to. The platform comes from the saved plan, so no `--platform` is needed. Report:

- applied and failed counts. Pit Crew reads each record again just before writing; anything in `liveChanged` was edited by someone after the dry run and was left alone, so say which pages those were.
- verification: `verified` (the new title and meta are being served, a theme suffix such as " – Shop name" after them is fine), `pending` (the change is saved but a cache or CDN may still show the old page; it can take minutes to hours) and any that failed
- Git: the live site cannot show the change until it is deployed, so say "not deployed yet" for those (the output has `notDeployedYet` and `deployNote`), never "failed".
- any `warnings`, in plain words (for example the backup was already applied once)
- the rollback command, ready to paste:

```
/pitcrew rollback <site> <backupId>
```

Webflow: finish with "Now open Webflow and publish the site so these go live." Shopify, WordPress and Git: nothing to add unless something failed.

If some changes failed, list them with the reason and offer to try just those again by running `publish-plan` once more (the ones already live are skipped because their live value now differs). Do not retry silently.

### Git: the diff, the commit and the deploy

For the Git route, `publish-apply` edits the files in the repo. Show the change in the folder from `repoDir`:

```
git -C <repoDir> diff
```

Summarise it: how many files, a few before and after lines. Then ask separately:

1. "Commit these changes?" Only on a yes, commit with a plain message such as `Update titles, meta descriptions and H1s (Pit Crew)`.
2. "Deploy?" A second, separate yes. Only if a deploy route exists (the Netlify CLI or the Netlify MCP in this session). Never push, never deploy without that yes. If there is no route, say how they deploy as they normally do.

A yes to the commit is not a yes to the deploy.

## Rollback

`/pitcrew rollback <site> <backup-id>`. Tell them what it does before running it: "This puts back the titles, descriptions and H1s from before the publish, for the fields Pit Crew changed."

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pitcrew.ts" rollback --site <host> --backup <backup-id>
```

If the rollback is in a later session than the plan's run, or a newer run exists, add `--date <run date>` (the date of the run where the plan was made, the folder name under `runs/`); otherwise the latest run is used and the backup will not be found. The platform comes from the saved plan.

- Only the fields that were actually applied are restored. Fields that were never changed, and live values edited by someone else since, are left alone; those are listed in `leftAlone`, so name them.
- A field that was empty before the publish is cleared again where the platform allows it (Shopify, WordPress, Webflow, and a meta description Pit Crew added to a Git file). A field it cannot clear is reported as not restorable; say so plainly.
- Use `--all-fields` only if they explicitly ask for every field in the backup to be restored, and only after you explain that this also overwrites fields Pit Crew never changed, including any edits made since. Without that ask, never add it.
- Report `restored` and `failed`, and any `warnings`. The backup id comes from the publish report or the `backups` folder of the run; if they do not have it, list the files in `backups/` and ask which one.
- Webflow: remind them to publish the site in Webflow so the restore goes live.
- Git: the same flow as publish: show `git diff`, and ask for the commit and the deploy as separate yeses.

Assist-mode changes have no API rollback. The workbook's current columns are the record of the old values: use them to put values back, again in batches of 10 with a confirmation each time.

Built by Unfayr · unfayr.com
