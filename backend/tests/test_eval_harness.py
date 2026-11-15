"""The harness runs the real sync and chat code paths without Gmail, Gemini, or Atlas."""

import asyncio
from datetime import datetime, timezone

from mongomock_motor import AsyncMongoMockClient

from evals import harness

main = harness.import_main()


def test_fixtures_ingest_through_the_sync_path():
    emails = harness.load_emails()

    async def scenario():
        db = AsyncMongoMockClient()["test"]
        await harness.ingest(main, db, emails, datetime.now(timezone.utc))
        return await db["emails"].find({"owner_session": harness.SESSION_ID}).to_list(length=None)

    stored = asyncio.run(scenario())
    assert {d["id"] for d in stored} == {e["id"] for e in emails}
    assert all(len(d["emb_subject"]) == 384 for d in stored)


def test_every_question_runs_through_the_chat_path():
    rows = asyncio.run(harness.run_all(main, live=False))
    assert len(rows) == len(harness.load_questions())
    assert [r["id"] for r in rows if r.get("error")] == []
