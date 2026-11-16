"""Which stored emails a request may read.

Every read of the `emails` collection builds its query here, so ownership, account
connection, and the rolling 30-day window are enforced in one place.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

WINDOW = timedelta(days=30)


def eligible_filter(
    owner_session: str,
    accounts: list[str],
    *,
    now: datetime | None = None,
    account_email: str | None = None,
    unread_only: bool = False,
    has_attachment: bool = False,
    newer_than: timedelta | None = None,
) -> dict:
    """MongoDB filter for the emails this owner may read at `now` (default: the current time).

    `accounts` are the owner's connected Gmail accounts; mail from any other account is
    excluded. `newer_than` narrows the window and can never widen it. An email without a
    `message_timestamp` never matches.
    """
    now = now or datetime.now(UTC)
    since = now - min(newer_than or WINDOW, WINDOW)
    if account_email:
        allowed = [a for a in accounts if a == account_email]
    else:
        allowed = [*accounts, None]  # None also matches mock-seed emails, which have no account
    query: dict = {
        "owner_session": owner_session,
        "accountEmail": {"$in": allowed},
        "message_timestamp": {"$gte": since, "$lte": now},
    }
    if unread_only:
        query["isUnread"] = True
    if has_attachment:
        query["hasAttachment"] = True
    return query
