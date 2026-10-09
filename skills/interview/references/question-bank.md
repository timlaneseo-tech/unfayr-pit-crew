# Pit Crew question bank

Ask only what the crawl could not answer, at most 5 questions per site, one per message. Each is skippable. Within a section, questions are in priority order. Take `All sites` first, then the sections for the page types that make up most of the site.

Each entry is: `id` (saved in `interview.json`), the question as you ask it, and what it unlocks.

## All sites

1. `differentiator`: "What do customers most often choose you for over the competition?" Unlocks: the one honest reason in titles and metas.
2. `proof`: "Is there one number you can stand behind? Years in business, jobs done, reviews, response time." Unlocks: the only number the writer may use as proof. Ask for the figure and what it counts.
3. `action`: "What is the one thing you want a visitor to do? Call, request a quote, buy, book?" Unlocks: the call to action in metas.
4. `brand`: "How do you write your business name, exactly?" Ask only if the brand on the site is inconsistent. Unlocks: the brand spelling lint enforces.

## Home

1. `business`: "In a sentence, what does the business do and for whom?" Ask only if the home page text does not say it.
2. `area`: "Where do you work? A city, a region, or the whole country?" Unlocks: the place in the home title.

## Service

1. `areas`: "Which towns or areas do you actually serve?" Unlocks: the city in `{Service} in {City}`. Never put a town in a title that is not on this list.
2. `services_main`: "Which service brings in the most work?" Unlocks: which service page is a top page when there is no click data.
3. `emergency`: "Do you take emergency or same-day calls?" Ask only if relevant. Unlocks: a true availability claim.
4. `credentials`: "Any licence, certification or insurance you want mentioned?" Unlocks: a claim that would otherwise be blocked as unsourced.
5. `price`: "Is there a starting price or typical price range you're happy to show?" Optional and skippable; counts toward the 5-question cap. Unlocks: a price in the meta (for example "From $89") and a starting-price fact for AI answers. Ask for the exact figure and what it covers.

## Location

1. `areas`: "Which towns or areas do you actually serve?" Skip if already answered under Service.
2. `address`: "Is there a street address or office people can visit, or do you travel to them?" Unlocks: whether a metas can say "visit" or "we come to you".
3. `hours`: "What are your opening hours, if you want them shown?" Unlocks: hours in metas for local pages.

## Product

1. `checks`: "What do buyers check before they buy? Fitment, size, compatibility, material?" Unlocks: the key spec in `{Product} {Key spec}`.
2. `shipping`: "Is there a free shipping or returns threshold you want mentioned?" Unlocks: shipping and returns lines in metas. Ask for the exact amount and terms.
3. `brands`: "Which brands or makes do you carry that people search for by name?" Unlocks: brand names allowed in titles.
4. `stock`: "Is everything in stock and shipped by you, or are some items made to order or sent from a supplier?" Unlocks: whether a meta may say "in stock" or "ships fast".
5. `price`: "Is there a starting price or typical price range you're happy to show?" Optional and skippable; counts toward the 5-question cap. Unlocks: a price in the meta (for example "From $89") and a starting-price fact for AI answers. Ask for the exact figure and what it covers.

## Collection

1. `checks`: "What do buyers check before they buy from this range? Fitment, size, compatibility?" Skip if already answered under Product.
2. `categories`: "Which categories matter most to your sales?" Unlocks: which collection pages are top pages when there is no click data.
3. `shipping`: "Is there a free shipping or returns threshold you want mentioned?" Skip if already answered under Product.

## Article

1. `expert`: "Who is the expert behind the content, and what are their credentials?" Unlocks: an author line and any "by a licensed X" claim. Credentials must be real and checkable.
2. `audience`: "Who are the articles for? Homeowners, trade buyers, beginners?" Unlocks: the reader in the promise half of `{Topic}: {Promise}`.
3. `freshness`: "Are the articles kept up to date, and when were they last checked?" Unlocks: whether a meta may say "updated" or show a year.

## Notes for the interviewer

- A skipped question is saved with `answer: null`. The writer then uses an `[ADD: ...]` slot where that fact would have gone, and the workbook shows it.
- Never save an answer you have guessed. If they say "whatever you think", save `null`.
- There is no section for pages typed `other`. Those are written from their own page text and the `All sites` answers.
