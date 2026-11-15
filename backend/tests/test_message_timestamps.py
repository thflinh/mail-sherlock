"""Gmail's internalDate is saved at ingest, and the one-time backfill fills older records."""

import asyncio
from datetime import UTC, datetime

from evals import harness
from mongomock_motor import AsyncMongoMockClient
from scripts import backfill_message_timestamps as backfill

main = harness.import_main()
EMAILS = harness.load_emails()
PRIMARY = "alex.rivera@example.com"
RECENT = {e["id"] for e in EMAILS if e["age_days"] <= backfill.LISTING_DAYS}


def _as_utc(value: datetime) -> datetime:
    """MongoDB returns naive UTC datetimes unless the client is created tz-aware."""
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _internal_date(fakes: dict, account: str, email_id: str) -> datetime:
    raw = fakes[account].get(userId="me", id=email_id, format="minimal").execute()
    return datetime.fromtimestamp(int(raw["internalDate"]) / 1000, UTC)


def test_sync_stores_internal_date_as_message_timestamp():
    async def scenario():
        db = AsyncMongoMockClient()["test"]
        fakes = await harness.ingest(main, db, EMAILS, datetime.now(UTC))
        return fakes, await db["emails"].find({}).to_list(length=None)

    fakes, docs = asyncio.run(scenario())
    assert len(docs) == len(EMAILS)
    for d in docs:
        assert _as_utc(d["message_timestamp"]) == _internal_date(fakes, d["accountEmail"], d["id"])


def test_missing_internal_date_is_stored_as_none():
    raw = harness.to_gmail_message(EMAILS[0], datetime.now(UTC))
    del raw["internalDate"]
    assert main._raw_message_to_doc(raw, PRIMARY)["message_timestamp"] is None


async def _legacy_mailbox(monkeypatch):
    """The fixtures as syncs before this change left them: no message_timestamp."""
    db = AsyncMongoMockClient()["test"]
    fakes = await harness.ingest(main, db, EMAILS, datetime.now(UTC))
    await db["emails"].update_many({}, {"$unset": {"message_timestamp": ""}})
    rows = [{"email": a, "session_id": harness.SESSION_ID, "token_json": "{}"} for a in fakes]
    await db["settings"].update_one({"_id": main.ACCOUNTS_DOC_ID}, {"$set": {"accounts": rows}})

    async def fake_credentials(row):
        return harness.FakeCredentials(row["email"])

    monkeypatch.setattr(main, "_credentials_from_row", fake_credentials)
    monkeypatch.setattr(main, "build", lambda *_args, credentials, **_kwargs: fakes[credentials.account])
    return db, fakes


def _total(result: dict, key: str) -> int:
    return sum(r[key] for r in result["accounts"])


def test_fixtures_include_mail_outside_the_listing():
    assert 0 < len(RECENT) < len(EMAILS)


def test_dry_run_counts_and_writes_nothing(monkeypatch):
    async def scenario():
        db, _ = await _legacy_mailbox(monkeypatch)
        result = await backfill.backfill(db, dry_run=True)
        return result, await db["emails"].count_documents({"message_timestamp": {"$ne": None}})

    result, stamped = asyncio.run(scenario())
    assert _total(result, "missing_timestamp") == len(EMAILS)
    assert _total(result, "to_fetch") == len(RECENT)
    assert _total(result, "outside_window") == len(EMAILS) - len(RECENT)
    assert _total(result, "backfilled") == 0 and stamped == 0


def test_backfill_sets_internal_date_only_for_recent_mail(monkeypatch):
    async def scenario():
        db, fakes = await _legacy_mailbox(monkeypatch)
        result = await backfill.backfill(db, dry_run=False)
        return result, fakes, await db["emails"].find({}).to_list(length=None)

    result, fakes, docs = asyncio.run(scenario())
    assert _total(result, "backfilled") == len(RECENT)
    assert result["remaining_without_timestamp"] == len(EMAILS) - len(RECENT)
    for d in docs:
        if d["id"] in RECENT:
            assert _as_utc(d["message_timestamp"]) == _internal_date(fakes, d["accountEmail"], d["id"])
        else:
            assert d.get("message_timestamp") is None


def test_second_run_has_nothing_left_to_fetch(monkeypatch):
    async def scenario():
        db, _ = await _legacy_mailbox(monkeypatch)
        await backfill.backfill(db, dry_run=False)
        return await backfill.backfill(db, dry_run=False)

    again = asyncio.run(scenario())
    assert _total(again, "to_fetch") == 0 and _total(again, "backfilled") == 0


def test_message_deleted_after_listing_is_counted_and_left_alone(monkeypatch):
    list_recent_ids = backfill._list_recent_ids
    # Listed by Gmail, then deleted before the per-message fetch.
    monkeypatch.setattr(backfill, "_list_recent_ids", lambda svc: list_recent_ids(svc) | {"ghost-01"})

    async def scenario():
        db, _ = await _legacy_mailbox(monkeypatch)
        await db["emails"].insert_one({"id": "ghost-01", "owner_session": harness.SESSION_ID, "accountEmail": PRIMARY})
        result = await backfill.backfill(db, dry_run=False)
        return result, await db["emails"].find_one({"id": "ghost-01"})

    result, ghost = asyncio.run(scenario())
    assert _total(result, "not_found") == 1
    assert _total(result, "backfilled") == len(RECENT)
    assert ghost.get("message_timestamp") is None
