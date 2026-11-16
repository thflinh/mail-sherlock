"""One-time backfill: copy Gmail's internalDate into `message_timestamp` for stored emails.

Emails synced before this field existed only have the `Date` header. For each connected
account this lists the message IDs Gmail has from the last 31 days (one day wider than the
30-day window), then fetches `format=minimal` only for stored emails in that list that have
no timestamp yet. Stored emails outside the list are older than the window, deleted, or in
Spam/Trash: they keep no timestamp, so the 30-day cutoff excludes them, and retention
cleanup removes them later. Safe to re-run; it only touches emails still missing the field.

Run from backend/ (uses MONGODB_URI and the account tokens stored in the database):
    python -m scripts.backfill_message_timestamps --dry-run
    python -m scripts.backfill_message_timestamps
"""

from __future__ import annotations

import argparse
import asyncio

import main as app
from db import close_db, connect_db, get_db
from google.auth.exceptions import RefreshError, TransportError
from google.auth.transport.requests import Request as GoogleRequest
from googleapiclient.errors import HttpError

LISTING_DAYS = 31


def _list_recent_ids(svc) -> set[str]:
    ids: set[str] = set()
    page_token = None
    while True:
        kwargs = {"userId": "me", "maxResults": 500, "q": f"newer_than:{LISTING_DAYS}d"}
        if page_token:
            kwargs["pageToken"] = page_token
        response = svc.users().messages().list(**kwargs).execute()
        ids.update(m["id"] for m in response.get("messages", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            return ids


async def _backfill_account(db, row: dict, *, dry_run: bool) -> dict:
    account = row["email"].strip()
    report = {"account": account, "missing_timestamp": 0, "to_fetch": 0, "outside_window": 0,
              "backfilled": 0, "not_found": 0, "failed": 0, "error": None}

    creds = await app._credentials_from_row(row)
    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(GoogleRequest())
        except (RefreshError, TransportError) as exc:
            report["error"] = f"token refresh failed ({exc}); reconnect the account"
            return report
        if not dry_run:
            await app._persist_refreshed_credentials(db, account, creds)

    svc = app.build("gmail", "v1", credentials=creds)
    try:
        listed = _list_recent_ids(svc)
    except HttpError as exc:
        report["error"] = f"listing failed: {exc.reason}"
        return report

    stored = await db["emails"].find(
        # {field: None} matches both a missing field and an explicit null.
        {"owner_session": row["session_id"], "accountEmail": account, "message_timestamp": None},
        {"id": 1, "_id": 0},
    ).to_list(length=None)
    to_fetch = [d["id"] for d in stored if d["id"] in listed]
    report.update(missing_timestamp=len(stored), to_fetch=len(to_fetch), outside_window=len(stored) - len(to_fetch))
    if dry_run:
        return report

    for email_id in to_fetch:
        try:
            raw = svc.users().messages().get(userId="me", id=email_id, format="minimal").execute()
        except HttpError as exc:
            report["not_found" if exc.resp.status == 404 else "failed"] += 1
            continue
        timestamp = app._gmail_message_timestamp(raw)
        if timestamp is None:
            report["failed"] += 1
            continue
        await db["emails"].update_one(
            {"id": email_id, "owner_session": row["session_id"]},
            {"$set": {"message_timestamp": timestamp}},
        )
        report["backfilled"] += 1
    return report


async def backfill(db, *, dry_run: bool) -> dict:
    doc = await db["settings"].find_one({"_id": app.ACCOUNTS_DOC_ID}) or {}
    rows = [
        r for r in doc.get("accounts") or []
        if isinstance(r, dict) and r.get("token_json") and r.get("session_id") and (r.get("email") or "").strip()
    ]
    reports = [await _backfill_account(db, r, dry_run=dry_run) for r in rows]
    remaining = await db["emails"].count_documents({"message_timestamp": None})
    return {"accounts": reports, "remaining_without_timestamp": remaining}


def _print_report(result: dict, dry_run: bool) -> None:
    for r in result["accounts"]:
        if r["error"]:
            print(f"{r['account']}: {r['error']}")
            continue
        done = f"would fetch {r['to_fetch']}" if dry_run else f"backfilled {r['backfilled']}"
        print(
            f"{r['account']}: {r['missing_timestamp']} without a timestamp; {done}; "
            f"{r['outside_window']} not in Gmail's last {LISTING_DAYS} days; "
            f"{r['not_found']} not found; {r['failed']} failed"
        )
    print(f"Emails still without a timestamp (the cutoff will exclude them): {result['remaining_without_timestamp']}")


async def _run(dry_run: bool) -> dict:
    await connect_db()
    try:
        return await backfill(get_db(), dry_run=dry_run)
    finally:
        await close_db()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="list and count only; fetch and write nothing")
    args = parser.parse_args()
    _print_report(asyncio.run(_run(args.dry_run)), args.dry_run)


if __name__ == "__main__":
    main()
