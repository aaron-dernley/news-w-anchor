/**
 * Method-level tests for `broadcast` and `forget` with a fake model context
 * and mocked `fetch`. No real network.
 *
 * @module
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20260828.33";
import { model } from "./news_w_anchor.ts";

// deno-lint-ignore no-explicit-any
const asCtx = (c: unknown): any => c;

const FEED_URL = "https://feed.example/rss";
const ARTICLE_URL = "https://feed.example/posts/joke-1";
const WEBHOOK = "https://discord.example/api/webhooks/1/abc";

const GLOBAL_ARGS = {
  webhookUrl: WEBHOOK,
  feeds: [{ name: "Example News", url: FEED_URL }],
  username: "News w/ Anchor",
  ledgerSize: 1500,
  enrichFromArticle: true,
  dryRun: false,
};

const RSS_ONE = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item>
    <title>Local Man Still Talking</title>
    <link>${ARTICLE_URL}</link>
    <guid isPermaLink="false">example:joke-1</guid>
    <description><![CDATA[He would not stop.]]></description>
    <pubDate>Mon, 08 Sep 2026 09:00:00 +0000</pubDate>
  </item>
</channel></rss>`;

const ARTICLE_HTML = `<html><head>
  <meta property="og:image" content="https://feed.example/img/joke-1.jpg">
  <meta property="og:description" content="Full blurb from the page.">
</head><body>...</body></html>`;

function router(req: Request): Response {
  const url = req.url;
  if (url === FEED_URL) return new Response(RSS_ONE, { status: 200 });
  if (url === ARTICLE_URL) return new Response(ARTICLE_HTML, { status: 200 });
  if (url.startsWith(WEBHOOK)) return new Response(null, { status: 204 });
  return new Response("unexpected", { status: 500 });
}

Deno.test("broadcast (dryRun): writes the pick, posts nothing, no ledger write", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...GLOBAL_ARGS, dryRun: true },
    methodName: "broadcast",
  });

  const { calls } = await withMockedFetch(
    router,
    () => model.methods.broadcast.execute({}, asCtx(context)),
  );

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "broadcast");
  assertEquals(written[0].name, "last-run");
  assertEquals(written[0].data.discordStatus, "dry-run");
  assertEquals(written[0].data.title, "Local Man Still Talking");
  assert(!calls.some((c) => c.url.startsWith(WEBHOOK)), "must not call Discord");
});

Deno.test("broadcast (live): posts an embed, then writes ledger + broadcast", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "broadcast",
  });

  const { calls } = await withMockedFetch(
    router,
    () => model.methods.broadcast.execute({}, asCtx(context)),
  );

  const post = calls.find((c) => c.url.startsWith(WEBHOOK));
  assert(post, "Discord POST was made");
  assertEquals(post?.method, "POST");
  const body = JSON.parse(post!.body ?? "{}");
  assertEquals(body.username, "News w/ Anchor");
  assertEquals(body.embeds[0].title, "Local Man Still Talking");
  assertEquals(body.embeds[0].url, ARTICLE_URL);
  assertEquals(body.embeds[0].image.url, "https://feed.example/img/joke-1.jpg");
  assertEquals(body.embeds[0].author.name, "Example News");

  const written = getWrittenResources();
  const ledger = written.find((w) => w.specName === "ledger");
  const broadcast = written.find((w) => w.specName === "broadcast");
  assertEquals(broadcast?.data.discordStatus, "posted");
  assertEquals((ledger?.data.entries as unknown[]).length, 1);
  assertEquals(
    (ledger?.data.entries as { id: string }[])[0].id,
    "example:joke-1",
  );
});

Deno.test("broadcast: appends to an existing ledger, capped at ledgerSize", async () => {
  const existing = Array.from({ length: 3 }, (_, i) => ({
    id: `old-${i}`,
    source: "Example News",
    title: `Old ${i}`,
    url: `https://feed.example/old-${i}`,
    postedAt: "2026-09-01T00:00:00.000Z",
  }));
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...GLOBAL_ARGS, ledgerSize: 3 },
    methodName: "broadcast",
    storedResources: {
      ledger: { entries: existing, updatedAt: "2026-09-01T00:00:00.000Z" },
    },
  });

  await withMockedFetch(
    router,
    () => model.methods.broadcast.execute({}, asCtx(context)),
  );

  const ledger = getWrittenResources().find((w) => w.specName === "ledger");
  const entries = ledger?.data.entries as { id: string }[];
  assertEquals(entries.length, 3);
  assertEquals(entries.map((e) => e.id), ["old-1", "old-2", "example:joke-1"]);
});

Deno.test("broadcast: every feed item already in the ledger → skipped-nothing-new", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "broadcast",
    storedResources: {
      ledger: {
        entries: [{
          id: "example:joke-1",
          source: "Example News",
          title: "Local Man Still Talking",
          url: ARTICLE_URL,
          postedAt: "2026-09-08T00:00:00.000Z",
        }],
        updatedAt: "2026-09-08T00:00:00.000Z",
      },
    },
  });

  const { calls } = await withMockedFetch(
    router,
    () => model.methods.broadcast.execute({}, asCtx(context)),
  );

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].data.discordStatus, "skipped-nothing-new");
  assertEquals(written[0].data.title, null);
  assert(!calls.some((c) => c.url.startsWith(WEBHOOK)));
});

Deno.test("broadcast: Discord failure throws and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "broadcast",
  });

  await assertRejects(
    () =>
      withMockedFetch(
        (req) =>
          req.url.startsWith(WEBHOOK)
            ? new Response("server error", { status: 500 })
            : router(req),
        () => model.methods.broadcast.execute({}, asCtx(context)),
      ).then((r) => r.result),
    Error,
    "Discord webhook failed (500)",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("broadcast: enrichFromArticle=false skips the article fetch", async () => {
  const { context } = createModelTestContext({
    globalArgs: { ...GLOBAL_ARGS, enrichFromArticle: false },
    methodName: "broadcast",
  });

  const { calls } = await withMockedFetch(
    router,
    () => model.methods.broadcast.execute({}, asCtx(context)),
  );

  assert(!calls.some((c) => c.url === ARTICLE_URL), "no article page fetch");
  const post = calls.find((c) => c.url.startsWith(WEBHOOK));
  const body = JSON.parse(post!.body ?? "{}");
  assertEquals(body.embeds[0].image, undefined); // feed had no image
});

Deno.test("broadcast: one dead feed is skipped, a live one still posts", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {
      ...GLOBAL_ARGS,
      feeds: [
        { name: "Dead", url: "https://dead.example/rss" },
        { name: "Example News", url: FEED_URL },
      ],
    },
    methodName: "broadcast",
  });

  await withMockedFetch(
    (req) =>
      req.url === "https://dead.example/rss"
        ? new Response("nope", { status: 503 })
        : router(req),
    () => model.methods.broadcast.execute({}, asCtx(context)),
  );

  const broadcast = getWrittenResources().find((w) => w.specName === "broadcast");
  assertEquals(broadcast?.data.discordStatus, "posted");
  assertEquals(broadcast?.data.source, "Example News");
});

Deno.test("forget: removes a ledger entry by URL", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
    methodName: "forget",
    storedResources: {
      ledger: {
        entries: [
          { id: "a", source: "s", title: "A", url: "https://e.com/a", postedAt: "t" },
          { id: "b", source: "s", title: "B", url: "https://e.com/b", postedAt: "t" },
        ],
        updatedAt: "t",
      },
    },
  });

  await withMockedFetch(
    router,
    () => model.methods.forget.execute({ url: "https://e.com/a" }, asCtx(context)),
  );

  const ledger = getWrittenResources().find((w) => w.specName === "ledger");
  const entries = ledger?.data.entries as { id: string }[];
  assertEquals(entries.length, 1);
  assertEquals(entries[0].id, "b");
});
