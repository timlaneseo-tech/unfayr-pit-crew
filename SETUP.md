# Set up Pit Crew to publish.

You do not need any of this to run Pit Crew. Crawling, interviewing, writing and the workbook need no keys. You only need access when you want Pit Crew to publish approved rows to your site, and only for the platform you use.

You can follow the steps below by hand, or run `/pitcrew publish example.com` and Pit Crew will walk you through the same steps. Either way:

- Give Pit Crew the narrowest access that works. Every route below lists exactly what to tick, and nothing else.
- Never paste a token or password into the chat. Pit Crew makes a small file with placeholders, you paste the real values into that file yourself and save it, and Pit Crew stores them and deletes the file.
- Credentials are saved in `%APPDATA%\pitcrew\credentials.json` (`~/.config/pitcrew` on macOS and Linux), keyed by site. They are never written into your results folder and never printed.
- To revoke access at any time, delete the token or application password on the platform's side.

## Shopify.

Pit Crew uses a custom app with the least access that works.

1. In Shopify admin, go to Settings, then Apps and sales channels, then Develop apps. If it says custom app development is off, click Allow custom app development.
2. Click Create an app and name it Pit Crew.
3. Click Configure Admin API scopes and tick these, and nothing else:
   - `write_products` and `read_products`
   - `write_content` and `read_content`
   - `write_online_store_pages` and `read_online_store_pages`
4. Save, then click Install app.
5. Reveal the Admin API access token and copy it. Shopify shows it once. If you lose it, uninstall and reinstall the app to get a new one.
6. Note your store's `.myshopify.com` address.

Pit Crew needs: `shop` (the `.myshopify.com` address) and `token`.

What it writes: the SEO title and description for products, collections, pages and articles. H1s that would rename a product, page or article are skipped unless you opt in.

## WordPress.

1. Your site must use https. WordPress does not offer application passwords over plain http.
2. Sign in as an administrator or editor. Go to Users, then Profile, and scroll to Application Passwords.
3. Type the name Pit Crew and click Add New Application Password.
4. Copy the password it shows. It has spaces in it; keep them.
5. Note your username.

Pit Crew needs: `base` (your site address, such as `https://example.com`), `user` and `appPassword`.

If your SEO plugin (Yoast or Rank Math) does not let WordPress write its titles and descriptions from outside, which is common, Pit Crew writes a CSV instead (`wordpress-import.csv` in the run folder) and tells you how to import it with the plugin's own importer. The application password is still used to match your pages to their records.

## Webflow.

1. In Webflow, open the site, then Site settings, then Apps and integrations, then Generate API token.
2. Name it Pit Crew. Give it read and write access to Pages and CMS only, and nothing else.
3. Copy the token. Also copy the site ID (Site settings, General, near the bottom).
4. If the site has CMS collections (blog posts, products and so on), find which CMS fields hold the SEO title and the SEO description in each collection. Pit Crew asks once and remembers. Static pages need no mapping.

Pit Crew needs: `token`, `siteId`, and for CMS collections `cmsFields` (collection ID, then the field names for title and meta).

Edits to CMS items are saved as staged. After Pit Crew finishes, open Webflow and click Publish so they go live. Pit Crew never publishes the site for you.

## Static sites and Git.

No token. Pit Crew edits the files in a local clone of your site.

1. Make sure you have a local copy of the site's files, up to date with what is live.
2. Note the folder path and the public address of the site.

Pit Crew needs: `repoDir` (the folder, written with forward slashes such as `C:/sites/example`) and `origin` (the public address).

After the change, Pit Crew shows you the diff. Committing is its own yes, and deploying is a second, separate yes. Pit Crew never pushes.

## Any other platform.

Wix, Squarespace and other hosted builders have no direct route. The workbook is your handoff: copy the approved values into the platform's own SEO fields. If your Claude session has a connector for the platform, Pit Crew can drive it in batches of 10 with a yes for each batch, marked best effort because there is no API rollback.

Built by Unfayr · unfayr.com
