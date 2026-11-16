"""eligible_filter: the one query every email read goes through."""

import asyncio
from datetime import UTC, datetime, timedelta

from email_scope import WINDOW, eligible_filter
from mongomock_motor import AsyncMongoMockClient

NOW = datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
OWNER, ACCOUNT, OTHER_ACCOUNT = "session-1", "a@example.com", "b@example.com"


def _email(email_id: str, *, age=timedelta(days=1), **fields) -> dict:
    doc = {"id": email_id, "owner_session": OWNER, "accountEmail": ACCOUNT, "message_timestamp": NOW - age}
    return {**doc, **fields}


def _matching(docs: list[dict], **kwargs) -> list[str]:
    async def scenario():
        db = AsyncMongoMockClient()["test"]
        await db["emails"].insert_many(docs)
        accounts = kwargs.pop("accounts", [ACCOUNT])
        return await db["emails"].find(eligible_filter(OWNER, accounts, now=NOW, **kwargs)).to_list(length=None)

    return sorted(d["id"] for d in asyncio.run(scenario()))


def test_window_edges():
    docs = [
        _email("exactly-30-days", age=WINDOW),
        _email("one-second-older", age=WINDOW + timedelta(seconds=1)),
        _email("now", age=timedelta(0)),
        _email("one-second-ahead", age=-timedelta(seconds=1)),
    ]
    assert _matching(docs) == ["exactly-30-days", "now"]


def test_missing_or_null_timestamp_never_matches():
    no_field = _email("no-field")
    del no_field["message_timestamp"]
    assert _matching([no_field, _email("null", message_timestamp=None)]) == []


def test_other_owners_and_disconnected_accounts_are_excluded():
    docs = [
        _email("mine"),
        _email("other-owner", owner_session="session-2"),
        _email("disconnected", accountEmail=OTHER_ACCOUNT),
    ]
    assert _matching(docs) == ["mine"]


def test_email_without_account_is_allowed_for_mock_seed_data():
    seeded = _email("seeded")
    del seeded["accountEmail"]
    assert _matching([seeded]) == ["seeded"]


def test_account_chip_narrows_to_one_connected_account():
    docs = [_email("a"), _email("b", accountEmail=OTHER_ACCOUNT)]
    assert _matching(docs, accounts=[ACCOUNT, OTHER_ACCOUNT], account_email=OTHER_ACCOUNT) == ["b"]
    assert _matching(docs, accounts=[ACCOUNT], account_email=OTHER_ACCOUNT) == []


def test_chips_with_no_match_return_nothing():
    docs = [_email("read-no-attachment", isUnread=False, hasAttachment=False)]
    assert _matching(docs, unread_only=True) == []
    assert _matching(docs, has_attachment=True) == []


def test_chips_match_when_set():
    docs = [_email("unread", isUnread=True), _email("attached", hasAttachment=True), _email("plain")]
    assert _matching(docs, unread_only=True) == ["unread"]
    assert _matching(docs, has_attachment=True) == ["attached"]


def test_date_range_narrows_but_never_widens():
    docs = [_email("3-days", age=timedelta(days=3)), _email("20-days", age=timedelta(days=20))]
    docs.append(_email("40-days", age=timedelta(days=40)))
    assert _matching(docs, newer_than=timedelta(days=7)) == ["3-days"]
    assert _matching(docs, newer_than=timedelta(days=365)) == ["20-days", "3-days"]
