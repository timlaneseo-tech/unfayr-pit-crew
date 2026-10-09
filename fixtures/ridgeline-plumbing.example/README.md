# ridgeline-plumbing.example fixture

Platform-neutral local service business. Origin `https://ridgeline-plumbing.example`, brand "Ridgeline Plumbing".
Served by `sampleFetcher('ridgeline-plumbing.example')`: `sitemap.xml` and `robots.txt` map by path, every page maps to `pages/<slugFor(url)>.html`.

`sitemap.xml` lists 16 URLs: 12 kept pages and 4 that the crawl drops.

Dropped: `/old-page` (canonical points to `/water-heater-repair`), `/thanks` (meta robots noindex), `/blog/page/2` (pagination), `/drain-cleaning?ref=newsletter` (query).

Kept pages: `/` (home), five services (`/water-heater-repair`, `/drain-cleaning`, `/sewer-line-repair`, `/leak-detection`, `/emergency-plumbing`, all in the home `<nav>`), two locations (`/service-areas/boise`, `/service-areas/nampa`), three articles (`/blog/water-heater-anode-rod`, `/blog/frozen-pipes-boise`, `/blog/sewer-camera-inspection-cost`, with BlogPosting JSON-LD) and `/about`.

Designed properties across the 12 kept pages (pinned in `tests/crawl.test.ts`):

- Exactly 3 titles are longer than 60 characters (decoded code points): water heater repair, sewer line repair, and the anode rod article.
- 6 pages share one identical boilerplate meta description: the five services plus `/about`.
- Exactly 1 page has no `<h1>`: `/service-areas/nampa` (it uses an `<h2>`). Every other page has exactly one.
- One title contains an HTML entity (`Leak Detection &amp; Repair`), one a curly apostrophe (`Water Heater’s`, article title and H1).
- Every `<main>` has 150+ words. Home and About both say "Serving Boise since 1998" and "4.9 stars from 312 reviews"; no other page repeats those figures.
- The home footer links every kept page, `/blog/page/2` and one external link (`elsewhere.example`), so link-crawl mode finds the same 12 pages.
- No Shopify or WordPress markers.
