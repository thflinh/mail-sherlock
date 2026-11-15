"""Retrieval evaluation: which emails the chat path finds or answers from for each question.

Run from backend/:
    python -m evals.run_retrieval_eval
    python -m evals.run_retrieval_eval --out evals/results/<name>.json
    python -m evals.run_retrieval_eval --live

Offline (default) makes no Gemini calls: each question's `intent` stands in for query
understanding, and rerank uses the app's no-key fallback. It needs the local MiniLM model.
--live uses real Gemini query understanding, rerank and labeling with the key in
backend/.env; it sends only the synthetic fixtures.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from evals import harness


def summarize(rows: list[dict]) -> dict:
    def tally(key: str) -> dict:
        out: dict = {}
        for r in rows:
            entry = out.setdefault(r[key], {"passed": 0, "total": 0})
            entry["passed"] += bool(r["passed"])
            entry["total"] += 1
        return out

    scored = [r for r in rows if r["hit"] is not None]
    return {
        "passed": sum(bool(r["passed"]) for r in rows),
        "total": len(rows),
        "relevant_found": {"hits": sum(r["hit"] for r in scored), "total": len(scored)},
        "by_split": tally("split"),
        "by_category": tally("category"),
        "questions_with_out_of_window_mail": sum(bool(r["out_of_window"]) for r in rows),
        "errors": sum(bool(r.get("error")) for r in rows),
    }


def _git_commit() -> str | None:
    try:
        result = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return result.stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--live", action="store_true", help="use real Gemini calls on the synthetic fixtures")
    parser.add_argument("--out", help="write per-question results and the summary as JSON")
    args = parser.parse_args()

    app = harness.import_main(live=args.live)
    rows = asyncio.run(harness.run_all(app, live=args.live))
    summary = summarize(rows)

    print(f"\n{'question':<36} {'split':<8} {'category':<13} {'result':<7} detail")
    for r in rows:
        print(f"{r['id']:<36} {r['split']:<8} {r['category']:<13} {'PASS' if r['passed'] else 'FAIL':<7} {r['detail']}")
    splits = "  ".join(f"{k} {v['passed']}/{v['total']}" for k, v in summary["by_split"].items())
    print(f"\nPassed {summary['passed']}/{summary['total']}  ({splits})")
    print("By category: " + ", ".join(f"{k} {v['passed']}/{v['total']}" for k, v in summary["by_category"].items()))
    found = summary["relevant_found"]
    print(f"Relevant email found, ignoring scope problems: {found['hits']}/{found['total']}")
    print(f"Questions surfacing mail older than {harness.WINDOW_DAYS} days: {summary['questions_with_out_of_window_mail']}")

    if args.out:
        report = {
            "run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "mode": "live" if args.live else "offline",
            "git_commit": _git_commit(),
            "top_k": harness.TOP_K,
            "summary": summary,
            "questions": rows,
        }
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {out}")


if __name__ == "__main__":
    main()
