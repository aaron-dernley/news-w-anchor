# @aaronge/news-w-anchor

A [swamp](https://github.com/swamp-club/swamp) extension that posts one
piece of satire news to a Discord channel each day. It pulls a rotation of
joke-news RSS/Atom feeds — The Onion, ClickHole, Reductress, The Beaverton,
The Hard Times, The Daily Mash, NewsThump — picks an article it has not
posted before, and sends it to a Discord webhook as a rich embed (source,
linked headline, blurb, image, publish time). A ledger records every
article already posted so the same joke never lands twice.

## Installation

```sh
swamp extension pull @aaronge/news-w-anchor
```

## Usage

1. Create a Discord **incoming webhook** for the target channel
   (Channel → Edit Channel → Integrations → Webhooks → New Webhook →
   Copy Webhook URL).

2. Store it in a vault so it stays out of your model definitions:

   ```sh
   swamp vault create local_encryption news-secrets
   swamp vault put news-secrets DISCORD_WEBHOOK_URL   # hidden prompt — paste the URL
   ```

3. Create an instance and point `webhookUrl` at the vault:

   ```sh
   swamp model create @aaronge/news-w-anchor anchor
   ```

   ```yaml
   # models/@aaronge/news-w-anchor/anchor.yaml
   globalArguments:
     webhookUrl: '${{ vault.get(news-secrets, DISCORD_WEBHOOK_URL) }}'
     dryRun: true     # set false when you're ready to post for real
   ```

4. Dry-run it, then go live:

   ```sh
   swamp model method run anchor broadcast    # dryRun:true → picks + records, no post
   swamp data get anchor broadcast --json     # see what it chose
   # flip dryRun to false, then:
   swamp model method run anchor broadcast    # posts to Discord, writes the ledger
   ```

## Global arguments

| Arg                 | Default                 | Notes                                                                                  |
| ------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `webhookUrl`        | _(required)_            | Discord incoming-webhook URL. Prefer a `${{ vault.get(...) }}` reference over plaintext. |
| `feeds`             | 7 built-in satire feeds | `[{ name, url }]`. Replaces the default list entirely — point it at any RSS 2.0 or Atom feeds. |
| `username`          | `News Wanchor`          | Overrides the webhook's display name on each post.                                      |
| `avatarUrl`         | _(none)_                | Optional image URL for the poster's avatar (`avatar_url` webhook override). Omit to use the webhook's configured avatar. |
| `ledgerSize`        | `1500`                  | Max entries kept in the de-duplication ledger; oldest are pruned.                       |
| `enrichFromArticle` | `true`                  | When the feed item has no image or blurb, fetch the article page once and read its Open Graph tags. |
| `dryRun`            | `false`                 | When true, do everything except the Discord POST and the ledger write.                  |

Default feeds: The Onion, ClickHole, Reductress, The Beaverton, The Hard
Times, The Daily Mash, NewsThump.

## How it works

### Method `broadcast`

Fetches every configured feed (a feed that errors or returns nothing is
logged and skipped — one dead site never fails the run), collects all
articles, and drops any whose id is already in the ledger. An article's id
is the feed's own `<guid>` / Atom `<id>` when present, otherwise its
canonicalized URL. One of the remaining articles is chosen at random.

The post is a Discord **embed**: the feed name as the author line, the
headline as a link, a short blurb, the article image, and the publish time.
Images come from the feed (`<media:content>`, `<enclosure>`, or an `<img>`
in the body); if the feed has none and `enrichFromArticle` is on, the
article page's `og:image` / `og:description` are used instead. An article
with no image anywhere is still posted — just without one.

- **`dryRun: true`** — the chosen article is written to the `broadcast`
  resource with `discordStatus: "dry-run"`; nothing is posted, the ledger is
  untouched.
- **`dryRun: false`** — the article is POSTed to the webhook. Only after
  Discord accepts it (HTTP 2xx) is the ledger updated. If the post fails the
  method throws and the ledger is left alone, so the article is retried on
  the next run.
- **Nothing new** — if every current feed item is already in the ledger, the
  run writes `discordStatus: "skipped-nothing-new"` and posts nothing. A
  quiet day is not an error.

### Method `forget`

```sh
swamp model method run anchor forget --arg url=https://www.theonion.com/some-article
```

Removes an article from the ledger by URL or id so it can be posted again.
No-op if it is not present.

### Resource `broadcast`

The most recent run's outcome (instance `last-run`): `source`, `title`,
`url`, `summary`, `imageUrl`, `publishedAt`, `postedAt`, and `discordStatus`
(`posted` | `dry-run` | `skipped-nothing-new`). The article fields are
`null` only when `discordStatus` is `skipped-nothing-new`.

### Resource `ledger`

The de-duplication store — a single growing list of every article id posted
to Discord (`{ id, source, title, url, postedAt }`), pruned to the most
recent `ledgerSize` entries.

## Scheduling

There is no schedule built into the model — run `broadcast` on whatever
cadence you like. Two common ways:

### systemd timer + on-demand serve

A oneshot service runs a small script that brings up a `swamp serve` just
long enough to run one method, then a timer fires it daily:

```ini
# /etc/systemd/system/news-w-anchor.timer
[Timer]
OnCalendar=*-*-* 08:30:00
Persistent=true
[Install]
WantedBy=timers.target
```

### Persistent serve

If you already run `swamp serve` for this repo, wrap `broadcast` in a
one-step workflow and give it a `trigger.schedule` cron
(`"30 8 * * *"`); the serve scheduler fires it.

## License

MIT — see [LICENSE](LICENSE).
