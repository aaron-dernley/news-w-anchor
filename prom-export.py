#!/usr/bin/env python3
"""Turn `swamp data get anchor ledger|last-run --json` output into Prometheus
textfile metrics for the Fun Stuff Grafana dashboard.

Reads two `swamp data get … --json` blobs from stdin separated by a line
containing only `---` (ledger first, then last-run), and writes the
exposition-format metrics to stdout. Missing / empty / unparseable input
degrades to whatever subset of metrics can still be produced.
"""
import datetime
import json
import sys


def _content(blob: str):
    blob = blob.strip()
    if not blob:
        return None
    try:
        return json.loads(blob).get("content")
    except (ValueError, AttributeError):
        return None


def _esc(value) -> str:
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", " ")
    )


def _epoch(iso: str):
    try:
        return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None


def main() -> None:
    raw = sys.stdin.read().split("\n---\n", 1)
    ledger = _content(raw[0]) or {}
    last_run = _content(raw[1] if len(raw) > 1 else "") or {}
    entries = ledger.get("entries") or []

    out = [
        "# HELP news_w_anchor_posts_total Distinct articles posted to Discord so far (ledger size).",
        "# TYPE news_w_anchor_posts_total gauge",
        f"news_w_anchor_posts_total {len(entries)}",
    ]

    if entries:
        latest = entries[-1]
        out += [
            "# HELP news_w_anchor_last_post The most recent article posted, labeled with its source and headline (value always 1).",
            "# TYPE news_w_anchor_last_post gauge",
            f'news_w_anchor_last_post{{source="{_esc(latest.get("source", ""))}",'
            f'title="{_esc(latest.get("title", ""))}"}} 1',
        ]
        epoch = _epoch(latest.get("postedAt", ""))
        if epoch is not None:
            out += [
                "# HELP news_w_anchor_last_post_timestamp_seconds Unix time of the most recent article posted to Discord.",
                "# TYPE news_w_anchor_last_post_timestamp_seconds gauge",
                f"news_w_anchor_last_post_timestamp_seconds {epoch:.0f}",
            ]

    status = last_run.get("discordStatus")
    if status:
        out += [
            "# HELP news_w_anchor_last_run_status Outcome of the most recent broadcast run (1 on the current status label).",
            "# TYPE news_w_anchor_last_run_status gauge",
            f'news_w_anchor_last_run_status{{status="{_esc(status)}"}} 1',
        ]

    print("\n".join(out))


if __name__ == "__main__":
    main()
