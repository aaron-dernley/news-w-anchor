/**
 * Network smoke test: every feed in {@link DEFAULT_FEEDS} must return HTTP
 * 200 and parse to at least one item. Run this by hand when changing the
 * feed list — it is deliberately kept out of the default `deno test` gate
 * so an offline box does not fail the build:
 *
 * ```
 * NWA_FEED_SMOKE=1 ~/.swamp/deno/deno test --allow-net --allow-env \
 *   extensions/models/feeds_smoke_test.ts
 * ```
 *
 * @module
 */
import { assert } from "jsr:@std/assert@1";
import { DEFAULT_FEEDS, parseFeed } from "./news_w_anchor.ts";

// Opt-in only: `deno test extensions/` on an offline box (and with no
// --allow-env) must not fail here.
let ENABLED = false;
try {
  ENABLED = Deno.env.get("NWA_FEED_SMOKE") === "1";
} catch {
  ENABLED = false;
}

for (const feed of DEFAULT_FEEDS) {
  Deno.test({
    name: `feed reachable and parseable: ${feed.name}`,
    ignore: !ENABLED,
    fn: async () => {
      const resp = await fetch(feed.url, {
        headers: { "User-Agent": "news-w-anchor/1.0 (feed smoke test)" },
        signal: AbortSignal.timeout(20000),
      });
      assert(resp.ok, `${feed.name} returned HTTP ${resp.status}`);
      const items = parseFeed(await resp.text(), feed.name);
      assert(items.length >= 1, `${feed.name} parsed to zero items`);
    },
  });
}
