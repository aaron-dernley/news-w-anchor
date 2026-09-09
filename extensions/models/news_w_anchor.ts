/**
 * `@aaronge/news-w-anchor` — pulls a rotation of satire-news RSS/Atom feeds
 * (The Onion, ClickHole, Reductress, …), picks one article that has not been
 * posted before, and announces it to a Discord channel via an incoming
 * webhook as a rich embed (source, headline, blurb, image, timestamp). A
 * `ledger` resource records every article already sent so the same joke
 * never lands twice.
 *
 * The Discord POST is done directly from the model (a webhook call is a
 * single `fetch`) rather than via a separate messaging extension, so one
 * method run is one atomic "pick, post, record" unit.
 *
 * @module
 */
import { z } from "npm:zod@4";
// Only `XMLParser` is used, never `XMLBuilder`. The one open advisory on this
// version (GHSA-gh4j-gqv2-49f6, MEDIUM) is an XMLBuilder-only injection issue
// and does not apply here.
import { XMLParser } from "npm:fast-xml-parser@4.5.7";

/**
 * One normalized article distilled from a feed, regardless of whether the
 * source served RSS 2.0 or Atom.
 */
export interface FeedItem {
  /** Display name of the feed the item came from (the configured `name`). */
  source: string;
  /** Article headline, whitespace-trimmed, HTML entities decoded. */
  title: string;
  /** Canonical article URL. */
  url: string;
  /**
   * Stable de-duplication id: the feed's own `<guid>` / Atom `<id>` when it
   * provides one, otherwise the canonicalized URL.
   */
  id: string;
  /**
   * Plain-text blurb from `<description>` / `<content:encoded>` / `<summary>`
   * with HTML stripped, or `null` when the feed provides none.
   */
  summary: string | null;
  /**
   * A representative image URL pulled from the feed item
   * (`<media:content>`, `<enclosure>`, or the first `<img>` in the body),
   * or `null` when the feed carries no image.
   */
  imageUrl: string | null;
  /** Publish timestamp as the feed reported it (not parsed), or `null`. */
  publishedAt: string | null;
}

/**
 * A Discord embed object as accepted by the webhook API — the subset this
 * model populates.
 */
export interface DiscordEmbed {
  /** Feed name, shown as the small header line above the title. */
  author: { name: string };
  /** Article headline (Discord truncates display at 256 chars). */
  title: string;
  /** Article URL — makes the title a link. */
  url: string;
  /** Plain-text blurb, omitted when the article has none. */
  description?: string;
  /** Large image, omitted when no image could be found. */
  image?: { url: string };
  /** Article publish time as ISO-8601, omitted when unparseable. */
  timestamp?: string;
  /** Left-border colour (newsprint amber). */
  color: number;
}

/**
 * Default satire feeds. Every URL is confirmed to serve valid RSS 2.0 with
 * real items that carry a per-article link. Override the `feeds` global
 * argument to add, remove, or replace entries.
 */
export const DEFAULT_FEEDS: ReadonlyArray<{ name: string; url: string }> = [
  { name: "The Onion", url: "https://www.theonion.com/rss" },
  { name: "ClickHole", url: "https://clickhole.com/feed/" },
  { name: "Reductress", url: "https://reductress.com/feed/" },
  { name: "The Beaverton", url: "https://www.thebeaverton.com/feed/" },
  { name: "The Hard Times", url: "https://thehardtimes.net/feed/" },
  { name: "The Daily Mash", url: "https://www.thedailymash.co.uk/feed/" },
  { name: "NewsThump", url: "https://newsthump.com/feed/" },
];

/** Discord's display limit for an embed title. */
const EMBED_TITLE_LIMIT = 256;
/** Length this model trims embed descriptions to (well under Discord's 4096). */
const EMBED_DESCRIPTION_LIMIT = 350;
/** Left-border colour on every embed. */
const EMBED_COLOR = 0xf2a900;

/**
 * Normalize a URL for use as a de-duplication key: lowercase host, drop the
 * query string and fragment, and strip a trailing slash. Returns the input
 * trimmed if it cannot be parsed as an http(s) URL.
 */
export function canonicalizeUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  // Only http(s) article URLs are canonicalized; anything else (e.g. a
  // `tag:` or `urn:` guid) is returned untouched.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return trimmed;
  }
  parsed.search = "";
  parsed.hash = "";
  let path = parsed.pathname;
  if (path.endsWith("/")) path = path.slice(0, -1);
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
}

/**
 * Strip HTML tags from a string and collapse whitespace, decoding the
 * handful of entities that commonly survive feed parsing. Returns `""` for
 * empty or tag-only input.
 */
export function stripHtml(html: string): string {
  return (html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;|&#x27;/gi, "'")
    .replace(/&hellip;|&#8230;/gi, "…")
    .replace(/\s+/g, " ")
    .trim();
}

/** Return the `src` of the first `<img>` in an HTML fragment, or `null`. */
export function firstImageSrc(html: string): string | null {
  const match = (html ?? "").match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
}

/**
 * Pull `og:image` / `twitter:image` and `og:description` /
 * `<meta name="description">` out of a page's HTML `<head>`. Both fields are
 * `null` when the corresponding tag is absent.
 */
export function parseOpenGraph(
  html: string,
): { image: string | null; description: string | null } {
  const meta = (prop: string): string | null => {
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:property|name)\\s*=\\s*["']${prop}["'][^>]+content\\s*=\\s*["']([^"']+)["']`,
        "i",
      ),
      new RegExp(
        `<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]+(?:property|name)\\s*=\\s*["']${prop}["']`,
        "i",
      ),
    ];
    for (const re of patterns) {
      const m = (html ?? "").match(re);
      if (m) return m[1];
    }
    return null;
  };
  return {
    image: meta("og:image") ?? meta("twitter:image"),
    description: meta("og:description") ?? meta("description"),
  };
}

/** Convert a feed date (RFC-822 or ISO-8601) to an ISO-8601 string, or `null`. */
export function toIsoTimestamp(raw: string | null): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Build the Discord embed for an article. The title is truncated to
 * Discord's 256-char limit and the description to a short blurb; `image` and
 * `timestamp` are included only when available.
 */
export function buildEmbed(item: FeedItem): DiscordEmbed {
  const embed: DiscordEmbed = {
    author: { name: item.source },
    title: truncate(item.title, EMBED_TITLE_LIMIT),
    url: item.url,
    color: EMBED_COLOR,
  };
  const blurb = item.summary
    ? truncate(stripHtml(item.summary), EMBED_DESCRIPTION_LIMIT)
    : "";
  if (blurb) embed.description = blurb;
  if (item.imageUrl) embed.image = { url: item.imageUrl };
  const ts = toIsoTimestamp(item.publishedAt);
  if (ts) embed.timestamp = ts;
  return embed;
}

/** Truncate to `max` characters, appending an ellipsis when shortened. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Pick one element uniformly at random. `rng` defaults to `Math.random` and
 * can be supplied for deterministic tests. Throws on an empty array.
 */
export function pickRandom<T>(
  items: readonly T[],
  rng: () => number = Math.random,
): T {
  if (items.length === 0) throw new Error("pickRandom: empty array");
  return items[Math.floor(rng() * items.length)];
}

/** Coerce fast-xml-parser output (item, array of items, or undefined) to an array. */
function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    return [value as Record<string, unknown>];
  }
  return [];
}

/**
 * Extract text from a fast-xml-parser node that may be a bare string, a
 * number, or an object carrying `#text` (attributes present) or CDATA.
 */
function textOf(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node.trim() || null;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    const rec = node as Record<string, unknown>;
    const inner = rec["#text"] ?? rec["__cdata"];
    if (typeof inner === "string") return inner.trim() || null;
    if (typeof inner === "number") return String(inner);
  }
  return null;
}

/** Resolve the best `href` from an Atom `<link>` node (single or array). */
function atomLink(node: unknown): string | null {
  const links = asArray(node);
  if (links.length === 0) return typeof node === "string" ? node.trim() : null;
  const alternate = links.find((l) =>
    l["@_rel"] === "alternate" || l["@_rel"] == null
  );
  const chosen = alternate ?? links[0];
  const href = chosen["@_href"];
  return typeof href === "string" ? href.trim() : null;
}

/** First usable image URL from a parsed feed item's media tags or body HTML. */
function feedImage(raw: Record<string, unknown>): string | null {
  for (const key of ["media:content", "media:thumbnail"]) {
    for (const node of asArray(raw[key])) {
      const url = node["@_url"];
      if (typeof url === "string" && url) return url;
    }
  }
  for (const node of asArray(raw["enclosure"])) {
    const url = node["@_url"];
    const type = node["@_type"];
    if (
      typeof url === "string" && url &&
      (typeof type !== "string" || type.startsWith("image/"))
    ) {
      return url;
    }
  }
  const body = textOf(raw["content:encoded"]) ?? textOf(raw["description"]);
  return body ? firstImageSrc(body) : null;
}

/**
 * Parse an RSS 2.0 or Atom feed body into normalized {@link FeedItem}s.
 * Unknown or malformed XML yields an empty array rather than throwing, so a
 * single bad feed cannot abort a run. Items missing a title or a link are
 * dropped.
 */
export function parseFeed(xml: string, sourceName: string): FeedItem[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // WordPress feeds encode punctuation as HTML entities (&#8217; &#8230; …);
    // decode them so headlines read correctly in Discord.
    htmlEntities: true,
  });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }

  const items: FeedItem[] = [];

  const rss = (doc["rss"] as Record<string, unknown> | undefined)?.["channel"];
  for (
    const raw of asArray((rss as Record<string, unknown> | undefined)?.["item"])
  ) {
    const title = textOf(raw["title"]);
    const link = textOf(raw["link"]);
    if (!title || !link) continue;
    const guid = textOf(raw["guid"]);
    items.push({
      source: sourceName,
      title,
      url: link,
      id: guid && guid.length > 0 ? guid : canonicalizeUrl(link),
      summary: textOf(raw["description"]) ?? textOf(raw["content:encoded"]),
      imageUrl: feedImage(raw),
      publishedAt: textOf(raw["pubDate"]),
    });
  }

  const feed = doc["feed"] as Record<string, unknown> | undefined;
  for (const raw of asArray(feed?.["entry"])) {
    const title = textOf(raw["title"]);
    const link = atomLink(raw["link"]);
    if (!title || !link) continue;
    const atomId = textOf(raw["id"]);
    items.push({
      source: sourceName,
      title,
      url: link,
      id: atomId && atomId.length > 0 ? atomId : canonicalizeUrl(link),
      summary: textOf(raw["summary"]) ?? textOf(raw["content"]),
      imageUrl: feedImage(raw),
      publishedAt: textOf(raw["updated"]) ?? textOf(raw["published"]),
    });
  }

  return items;
}

const FeedConfigSchema = z.object({
  name: z.string().min(1).describe("Display name shown in the Discord post."),
  url: z.string().url().describe("RSS 2.0 or Atom feed URL."),
});

const GlobalArgsSchema = z.object({
  webhookUrl: z.string().url().meta({ sensitive: true }).describe(
    "Discord incoming-webhook URL for the target channel. Prefer a vault " +
      "reference: ${{ vault.get(news-secrets, DISCORD_WEBHOOK_URL) }}.",
  ),
  feeds: z.array(FeedConfigSchema).min(1).default([...DEFAULT_FEEDS]).describe(
    "Satire feeds to draw from. Defaults to a built-in rotation of 7.",
  ),
  username: z.string().default("News w/ Anchor").describe(
    "Overrides the webhook's display name on each post.",
  ),
  ledgerSize: z.number().int().positive().default(1500).describe(
    "Maximum entries kept in the de-duplication ledger; oldest are pruned.",
  ),
  enrichFromArticle: z.boolean().default(true).describe(
    "When the feed item has no image or blurb, fetch the article page once " +
      "and read its Open Graph tags to fill them in.",
  ),
  dryRun: z.boolean().default(false).describe(
    "When true, do everything except the Discord POST and the ledger write " +
      "— records the chosen article with discordStatus 'dry-run'.",
  ),
});

/** Static typing for `context.globalArgs` inside method bodies. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const BroadcastSchema = z.object({
  source: z.string().nullable().describe(
    "Feed name, or null when nothing new was found.",
  ),
  title: z.string().nullable(),
  url: z.string().nullable(),
  summary: z.string().nullable().describe(
    "Plain-text blurb shown in the embed.",
  ),
  imageUrl: z.string().nullable().describe(
    "Embed image URL, if one was found.",
  ),
  publishedAt: z.string().nullable().describe(
    "Publish timestamp as the feed reported it.",
  ),
  postedAt: z.string().describe("ISO-8601 time this run completed."),
  discordStatus: z.enum(["posted", "dry-run", "skipped-nothing-new"]).describe(
    "'posted' — sent to Discord and recorded in the ledger. 'dry-run' — " +
      "chosen but not sent (dryRun=true). 'skipped-nothing-new' — every " +
      "current feed item was already in the ledger.",
  ),
});

const LedgerEntrySchema = z.object({
  id: z.string(),
  source: z.string(),
  title: z.string(),
  url: z.string(),
  postedAt: z.string(),
});

const LedgerSchema = z.object({
  entries: z.array(LedgerEntrySchema).describe(
    "Every article already posted, oldest first.",
  ),
  updatedAt: z.string(),
});

type LedgerData = z.infer<typeof LedgerSchema>;

/** Fields a method body reads off the runtime-provided `context`. */
interface MethodContext {
  globalArgs: GlobalArgs;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
    warn(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

const USER_AGENT =
  "news-w-anchor/1.0 (+https://github.com/aaron-dernley/news-w-anchor)";

async function readLedger(context: MethodContext): Promise<LedgerData | null> {
  const raw = await context.readResource("ledger");
  if (!raw) return null;
  const parsed = LedgerSchema.safeParse(raw);
  return parsed.success ? parsed.data : { entries: [], updatedAt: "" };
}

async function fetchFeedItems(
  feeds: GlobalArgs["feeds"],
  logger: MethodContext["logger"],
): Promise<FeedItem[]> {
  const all: FeedItem[] = [];
  for (const feed of feeds) {
    try {
      const resp = await fetch(feed.url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        logger.warn("Feed {name} returned HTTP {status} — skipping", {
          name: feed.name,
          status: resp.status,
        });
        continue;
      }
      const items = parseFeed(await resp.text(), feed.name);
      if (items.length === 0) {
        logger.warn("Feed {name} parsed to zero items — skipping", {
          name: feed.name,
        });
        continue;
      }
      logger.info("Feed {name}: {count} items", {
        name: feed.name,
        count: items.length,
      });
      all.push(...items);
    } catch (err) {
      logger.warn("Feed {name} failed: {error} — skipping", {
        name: feed.name,
        error: String(err),
      });
    }
  }
  return all;
}

/**
 * Fill in a missing image and/or blurb from the article page's Open Graph
 * tags. Never throws — on any failure the item is returned unchanged.
 */
async function enrichFromArticle(
  item: FeedItem,
  logger: MethodContext["logger"],
): Promise<FeedItem> {
  if (item.imageUrl && item.summary) return item;
  try {
    const resp = await fetch(item.url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return item;
    const head = (await resp.text()).slice(0, 200_000);
    const og = parseOpenGraph(head);
    return {
      ...item,
      imageUrl: item.imageUrl ?? og.image,
      summary: item.summary ?? og.description,
    };
  } catch (err) {
    logger.warn("Could not enrich {url}: {error}", {
      url: item.url,
      error: String(err),
    });
    return item;
  }
}

/** Model definition for `@aaronge/news-w-anchor`. */
export const model = {
  type: "@aaronge/news-w-anchor",
  version: "2026.09.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    broadcast: {
      description:
        "The most recent run's chosen article and what happened to it.",
      schema: BroadcastSchema,
      lifetime: "infinite" as const,
      garbageCollection: 60,
    },
    ledger: {
      description:
        "De-duplication ledger — every article id already posted to Discord.",
      schema: LedgerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    broadcast: {
      description:
        "Fetch all feeds, pick one article not in the ledger, post it to " +
        "Discord as an embed, and record it. Honors the dryRun global argument.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const {
          feeds,
          username,
          webhookUrl,
          ledgerSize,
          enrichFromArticle: enrich,
          dryRun,
        } = context.globalArgs;
        const now = new Date().toISOString();
        context.logger.info(
          "broadcast: checking {count} feeds (dryRun={dryRun})",
          { count: feeds.length, dryRun },
        );

        const ledger = await readLedger(context);
        const seen = new Set(ledger?.entries.map((e) => e.id) ?? []);

        const items = await fetchFeedItems(feeds, context.logger);
        const candidates = items.filter((item) => !seen.has(item.id));
        context.logger.info(
          "{total} items across {feeds} feeds, {fresh} not yet posted",
          {
            total: items.length,
            feeds: feeds.length,
            fresh: candidates.length,
          },
        );

        if (candidates.length === 0) {
          context.logger.warn("Nothing new to post this run");
          const handle = await context.writeResource("broadcast", "last-run", {
            source: null,
            title: null,
            url: null,
            summary: null,
            imageUrl: null,
            publishedAt: null,
            postedAt: now,
            discordStatus: "skipped-nothing-new",
          });
          return { dataHandles: [handle] };
        }

        let chosen = pickRandom(candidates);
        if (enrich) chosen = await enrichFromArticle(chosen, context.logger);
        const embed = buildEmbed(chosen);

        const record: Record<string, unknown> = {
          source: chosen.source,
          title: chosen.title,
          url: chosen.url,
          summary: chosen.summary,
          imageUrl: chosen.imageUrl,
          publishedAt: chosen.publishedAt,
          postedAt: now,
          discordStatus: dryRun ? "dry-run" : "posted",
        };

        if (dryRun) {
          context.logger.info("dry run — would post: {title} ({url})", {
            title: chosen.title,
            url: chosen.url,
          });
          const handle = await context.writeResource(
            "broadcast",
            "last-run",
            record,
          );
          return { dataHandles: [handle] };
        }

        const resp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, embeds: [embed] }),
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          throw new Error(
            `Discord webhook failed (${resp.status}): ${body.slice(0, 300)}`,
          );
        }
        context.logger.info("Posted to Discord: {title}", {
          title: chosen.title,
        });

        const entries = [
          ...(ledger?.entries ?? []),
          {
            id: chosen.id,
            source: chosen.source,
            title: chosen.title,
            url: chosen.url,
            postedAt: now,
          },
        ].slice(-ledgerSize);
        const ledgerHandle = await context.writeResource("ledger", "ledger", {
          entries,
          updatedAt: now,
        });

        const broadcastHandle = await context.writeResource(
          "broadcast",
          "last-run",
          record,
        );

        return { dataHandles: [broadcastHandle, ledgerHandle] };
      },
    },
    forget: {
      description:
        "Remove an article from the ledger by URL or id so it can be posted " +
        "again. No-op if it is not present.",
      arguments: z.object({
        url: z.string().describe("The article URL or ledger id to forget."),
      }),
      execute: async (args: { url: string }, context: MethodContext) => {
        const ledger = await readLedger(context);
        if (!ledger || ledger.entries.length === 0) {
          context.logger.info("Ledger is empty — nothing to forget");
          return { dataHandles: [] };
        }
        const target = args.url.trim();
        const canonical = canonicalizeUrl(target);
        const kept = ledger.entries.filter(
          (e) =>
            e.id !== target && e.url !== target &&
            canonicalizeUrl(e.url) !== canonical,
        );
        const removed = ledger.entries.length - kept.length;
        context.logger.info("Forgetting {removed} ledger entr(y/ies)", {
          removed,
        });
        const handle = await context.writeResource("ledger", "ledger", {
          entries: kept,
          updatedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
