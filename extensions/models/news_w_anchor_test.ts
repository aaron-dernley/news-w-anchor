/**
 * Unit tests for the pure helpers in `news_w_anchor.ts`. No network.
 *
 * @module
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  buildEmbed,
  canonicalizeUrl,
  decodeEntities,
  type FeedItem,
  firstImageSrc,
  parseFeed,
  parseOpenGraph,
  pickRandom,
  sampleN,
  stripHtml,
  toIsoTimestamp,
} from "./news_w_anchor.ts";

const RSS_TWO_ITEMS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>The Onion</title>
  <link>https://www.theonion.com</link>
  <item>
    <title>Man Who Understands Bond Market Explains It To Everyone At Party</title>
    <link>https://www.theonion.com/man-who-understands-bond-market-1234</link>
    <guid isPermaLink="false">https://www.theonion.com/?p=1234</guid>
    <description>WASHINGTON—Adjusting his glasses...</description>
    <pubDate>Mon, 08 Sep 2026 14:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Report: You Could Be Doing More</title>
    <link>https://www.theonion.com/report-you-could-be-doing-more-5678/</link>
    <description><![CDATA[Sources confirmed <b>Tuesday</b>...]]></description>
    <pubDate>Tue, 09 Sep 2026 09:30:00 +0000</pubDate>
  </item>
</channel></rss>`;

const RSS_ONE_ITEM = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Solo</title>
  <item>
    <title><![CDATA[Only Story Here]]></title>
    <link>https://example.com/only</link>
    <guid>tag:example.com,2026:only</guid>
  </item>
</channel></rss>`;

const RSS_WITH_IMAGES = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <item>
    <title>Has media:content</title>
    <link>https://mash.example/a</link>
    <media:content medium="image" url="https://cdn.mash.example/a.jpg" />
  </item>
  <item>
    <title>Has enclosure</title>
    <link>https://bev.example/b</link>
    <enclosure url="https://bev.example/b.jpg" type="image/jpeg" length="1" />
  </item>
  <item>
    <title>Image only in description html</title>
    <link>https://thump.example/c</link>
    <description><![CDATA[<img src="https://thump.example/c.png" /> the joke]]></description>
  </item>
  <item>
    <title>No image at all</title>
    <link>https://onion.example/d</link>
    <description><![CDATA[just words]]></description>
  </item>
</channel></rss>`;

const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>McSweeney's</title>
  <entry>
    <title>An Open Letter To The Raccoon In My Compost</title>
    <link rel="alternate" href="https://www.mcsweeneys.net/articles/an-open-letter"/>
    <id>https://www.mcsweeneys.net/articles/an-open-letter</id>
    <summary>Dear Sir or Madam, we need to talk about the boundaries of this arrangement.</summary>
    <updated>2026-09-07T12:00:00Z</updated>
  </entry>
  <entry>
    <title>Reasons My Toddler Is Crying, Ranked</title>
    <link href="https://www.mcsweeneys.net/articles/reasons-ranked"/>
    <published>2026-09-05T08:00:00Z</published>
  </entry>
</feed>`;

Deno.test("parseFeed: RSS 2.0 with multiple items", () => {
  const items = parseFeed(RSS_TWO_ITEMS, "The Onion");
  assertEquals(items.length, 2);
  assertEquals(items[0].source, "The Onion");
  assertEquals(items[0].title, "Man Who Understands Bond Market Explains It To Everyone At Party");
  assertEquals(items[0].url, "https://www.theonion.com/man-who-understands-bond-market-1234");
  assertEquals(items[0].publishedAt, "Mon, 08 Sep 2026 14:00:00 +0000");
});

Deno.test("parseFeed: id is the guid when present, canonical url otherwise", () => {
  const items = parseFeed(RSS_TWO_ITEMS, "The Onion");
  assertEquals(items[0].id, "https://www.theonion.com/?p=1234");
  assertEquals(items[1].id, "https://www.theonion.com/report-you-could-be-doing-more-5678");
});

Deno.test("parseFeed: CDATA titles and descriptions are unwrapped", () => {
  const items = parseFeed(RSS_TWO_ITEMS, "The Onion");
  assertEquals(items[1].title, "Report: You Could Be Doing More");
  assert(items[1].summary?.includes("Tuesday"));
});

Deno.test("parseFeed: single <item> (parser yields an object, not an array)", () => {
  const items = parseFeed(RSS_ONE_ITEM, "Solo");
  assertEquals(items.length, 1);
  assertEquals(items[0].title, "Only Story Here");
  assertEquals(items[0].id, "tag:example.com,2026:only");
});

Deno.test("parseFeed: image from media:content, enclosure, or body <img>", () => {
  const items = parseFeed(RSS_WITH_IMAGES, "x");
  assertEquals(items[0].imageUrl, "https://cdn.mash.example/a.jpg");
  assertEquals(items[1].imageUrl, "https://bev.example/b.jpg");
  assertEquals(items[2].imageUrl, "https://thump.example/c.png");
  assertEquals(items[3].imageUrl, null);
});

Deno.test("parseFeed: Atom feed, link resolution and id fallback", () => {
  const items = parseFeed(ATOM_FEED, "McSweeney's");
  assertEquals(items.length, 2);
  assertEquals(items[0].url, "https://www.mcsweeneys.net/articles/an-open-letter");
  assertEquals(items[0].id, "https://www.mcsweeneys.net/articles/an-open-letter");
  assertEquals(
    items[0].summary,
    "Dear Sir or Madam, we need to talk about the boundaries of this arrangement.",
  );
  assertEquals(items[1].id, "https://www.mcsweeneys.net/articles/reasons-ranked");
  assertEquals(items[1].publishedAt, "2026-09-05T08:00:00Z");
});

Deno.test("parseFeed: HTML entities in titles are decoded", () => {
  const xml = `<rss version="2.0"><channel><item>
    <title>Woman&#8217;s New Plan &amp; Other &#8220;Ideas&#8221; &#8212; Ranked</title>
    <link>https://reductress.com/post/x/</link></item></channel></rss>`;
  const items = parseFeed(xml, "Reductress");
  assertEquals(items[0].title, "Woman’s New Plan & Other “Ideas” — Ranked");
});

Deno.test("parseFeed: non-feed input returns []", () => {
  assertEquals(parseFeed("<!DOCTYPE html><html><body>nope</body></html>", "x"), []);
  assertEquals(parseFeed("not xml at all {", "x"), []);
  assertEquals(parseFeed("", "x"), []);
});

Deno.test("parseFeed: items missing a title or link are dropped", () => {
  const xml = `<rss version="2.0"><channel>
    <item><link>https://e.com/a</link></item>
    <item><title>Has title, no link</title></item>
    <item><title>Good</title><link>https://e.com/c</link></item>
  </channel></rss>`;
  const items = parseFeed(xml, "x");
  assertEquals(items.length, 1);
  assertEquals(items[0].title, "Good");
});

Deno.test("canonicalizeUrl: strips query, fragment, trailing slash; lowercases host", () => {
  assertEquals(
    canonicalizeUrl("https://WWW.Example.com/path/?utm_source=x#frag"),
    "https://www.example.com/path",
  );
  assertEquals(canonicalizeUrl("https://example.com/"), "https://example.com");
  assertEquals(canonicalizeUrl("https://example.com"), "https://example.com");
});

Deno.test("canonicalizeUrl: idempotent", () => {
  const once = canonicalizeUrl("https://Example.com/a/b/?q=1");
  assertEquals(canonicalizeUrl(once), once);
});

Deno.test("canonicalizeUrl: non-URL input returned trimmed", () => {
  assertEquals(canonicalizeUrl("  tag:example.com,2026:1  "), "tag:example.com,2026:1");
});

Deno.test("stripHtml: removes tags, collapses whitespace, decodes common entities", () => {
  assertEquals(
    stripHtml("<p>Hello &amp; <b>welcome</b>\n  to   the   party&#8230;</p>"),
    "Hello & welcome to the party…",
  );
  assertEquals(stripHtml("<img src='x'>"), "");
  assertEquals(stripHtml(""), "");
});

Deno.test("stripHtml: strips entity-encoded HTML (the &lt;img&gt; blurb case)", () => {
  const raw =
    "&lt;img width=\"300\" src=\"https://e.com/x.jpg\" /&gt; The joke text is here.";
  assertEquals(stripHtml(raw), "The joke text is here.");
});

Deno.test("decodeEntities: named, decimal, hex, and double-encoded", () => {
  assertEquals(decodeEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assertEquals(decodeEntities("Women&#039;s News"), "Women's News");
  assertEquals(decodeEntities("caf&#xe9;"), "café");
  // double-encoded: &amp;#039; -> &#039; -> '
  assertEquals(decodeEntities("Women&amp;#039;s News"), "Women's News");
  assertEquals(decodeEntities("plain text"), "plain text");
});

Deno.test("parseFeed: a blurb that is only an image tag becomes null", () => {
  const xml = `<rss version="2.0"><channel><item>
    <title>Just an image</title>
    <link>https://e.com/a</link>
    <description><![CDATA[<img src="https://e.com/a.jpg" />]]></description>
  </item></channel></rss>`;
  const items = parseFeed(xml, "x");
  assertEquals(items[0].summary, null);
  assertEquals(items[0].imageUrl, "https://e.com/a.jpg");
});

Deno.test("firstImageSrc: returns the first <img> src or null", () => {
  assertEquals(
    firstImageSrc(`text <img width="3" src="https://e.com/a.png" alt=""> more`),
    "https://e.com/a.png",
  );
  assertEquals(firstImageSrc("no images here"), null);
});

Deno.test("parseOpenGraph: reads og:image / og:description in either attribute order", () => {
  const html = `<head>
    <meta property="og:image" content="https://e.com/og.jpg">
    <meta content="A very funny article." name="og:description">
  </head>`;
  const og = parseOpenGraph(html);
  assertEquals(og.image, "https://e.com/og.jpg");
  assertEquals(og.description, "A very funny article.");
});

Deno.test("parseOpenGraph: falls back to twitter:image and meta description", () => {
  const html = `<meta name="twitter:image" content="https://e.com/t.jpg">
    <meta name="description" content="Fallback blurb.">`;
  const og = parseOpenGraph(html);
  assertEquals(og.image, "https://e.com/t.jpg");
  assertEquals(og.description, "Fallback blurb.");
});

Deno.test("parseOpenGraph: absent tags → nulls", () => {
  assertEquals(parseOpenGraph("<html></html>"), { image: null, description: null });
});

Deno.test("toIsoTimestamp: RFC-822 and ISO in, ISO out; junk → null", () => {
  assertEquals(
    toIsoTimestamp("Mon, 08 Sep 2026 14:00:00 +0000"),
    "2026-09-08T14:00:00.000Z",
  );
  assertEquals(toIsoTimestamp("2026-09-05T08:00:00Z"), "2026-09-05T08:00:00.000Z");
  assertEquals(toIsoTimestamp("not a date"), null);
  assertEquals(toIsoTimestamp(null), null);
});

const FULL_ITEM: FeedItem = {
  source: "ClickHole",
  title: "6 Ways To Feel Alive",
  url: "https://clickhole.com/6-ways",
  id: "https://clickhole.com/6-ways",
  summary: "<p>Here are the ways.</p>",
  imageUrl: "https://clickhole.com/6-ways.jpg",
  publishedAt: "Tue, 09 Sep 2026 09:30:00 +0000",
};

Deno.test("buildEmbed: full item → author, linked title, blurb, image, timestamp", () => {
  const embed = buildEmbed(FULL_ITEM);
  assertEquals(embed.author, { name: "ClickHole" });
  assertEquals(embed.title, "6 Ways To Feel Alive");
  assertEquals(embed.url, "https://clickhole.com/6-ways");
  assertEquals(embed.description, "Here are the ways.");
  assertEquals(embed.image, { url: "https://clickhole.com/6-ways.jpg" });
  assertEquals(embed.timestamp, "2026-09-09T09:30:00.000Z");
  assert(typeof embed.color === "number");
});

Deno.test("buildEmbed: sparse item → no description/image/timestamp keys", () => {
  const embed = buildEmbed({
    source: "The Onion",
    title: "Headline",
    url: "https://theonion.com/x",
    id: "https://theonion.com/x",
    summary: null,
    imageUrl: null,
    publishedAt: null,
  });
  assertEquals(embed.description, undefined);
  assertEquals(embed.image, undefined);
  assertEquals(embed.timestamp, undefined);
});

Deno.test("buildEmbed: over-long title is truncated to 256 chars", () => {
  const embed = buildEmbed({ ...FULL_ITEM, title: "T".repeat(500) });
  assert(embed.title.length <= 256);
  assert(embed.title.endsWith("…"));
});

Deno.test("pickRandom: deterministic with a seeded rng", () => {
  const arr = ["a", "b", "c", "d"];
  assertEquals(pickRandom(arr, () => 0), "a");
  assertEquals(pickRandom(arr, () => 0.99), "d");
  assertEquals(pickRandom(arr, () => 0.5), "c");
});

Deno.test("pickRandom: throws on empty array", () => {
  assertThrows(() => pickRandom([]), Error, "empty");
});

Deno.test("sampleN: returns n distinct items, or all when n exceeds length", () => {
  const arr = ["a", "b", "c", "d"];
  const two = sampleN(arr, 2, () => 0);
  assertEquals(two.length, 2);
  assertEquals(new Set(two).size, 2);
  assertEquals(sampleN(arr, 10).length, 4);
  assertEquals(sampleN([], 3), []);
});

Deno.test("sampleN: deterministic with a seeded rng", () => {
  assertEquals(sampleN(["a", "b", "c"], 2, () => 0), ["a", "b"]);
});
