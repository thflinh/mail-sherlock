"""The 30-day scope, filters, and references hold through the real search, chat, and reader paths."""

import asyncio
from datetime import UTC, datetime, timedelta

import agent_search
import pytest
from evals import harness
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

main = harness.import_main()
EMAILS = harness.load_emails()
AGES = {e["id"]: e["age_days"] for e in EMAILS}
PRIMARY = "alex.rivera@example.com"

# Outcomes that depend only on scope, filters, and reference handling, not on ranking quality,
# so they must pass even with the tests' bag-of-words embeddings.
SCOPE_QUESTIONS = {
    "q16-univ-attachments",
    "q18-northwind-last-week",
    "q23-followup-second-while-reading",
    "q24-followup-third-of-two",
    "q27-old-lease-rent",
    "q28-gym-freeze",
}


def test_scope_and_reference_questions_pass():
    rows = asyncio.run(harness.run_all(main, live=False))
    failed = {r["id"]: r["detail"] for r in rows if r["id"] in SCOPE_QUESTIONS and not r["passed"]}
    assert failed == {}


def test_no_question_surfaces_mail_older_than_30_days():
    rows = asyncio.run(harness.run_all(main, live=False))
    assert {r["id"]: r["out_of_window"] for r in rows if r["out_of_window"]} == {}


def test_ordinal_pointing_at_an_expired_email_asks_instead_of_answering():
    question = {
        "id": "expired-ordinal", "split": "dev", "category": "follow_up", "expect": "clarify",
        "relevant_ids": [], "question": "What did the first one say?",
        "context_ids": ["lease-old", "acme-04"],
        "intent": {"mode": "answer", "uses_prior_context": True, "context_ref": "first"},
    }

    async def scenario():
        db = AsyncMongoMockClient()["test"]
        fakes = await harness.ingest(main, db, EMAILS, datetime.now(UTC))
        return await harness.run_question(main, db, question, AGES, fakes, live=False)

    row = asyncio.run(scenario())
    assert row["mode"] == "clarify" and row["used"] is None and row["passed"]


async def _reader_db():
    db = AsyncMongoMockClient()["test"]
    fakes = await harness.ingest(main, db, EMAILS, datetime.now(UTC))
    recent = {"owner_session": harness.SESSION_ID, "accountEmail": PRIMARY,
              "message_timestamp": datetime.now(UTC) - timedelta(days=1), "subject": "x"}
    await db["emails"].insert_many([
        {**recent, "id": "other-owner", "owner_session": "someone-else"},
        {**recent, "id": "disconnected", "accountEmail": "old@example.com"},
    ])
    return db, fakes


@pytest.mark.parametrize("email_id", ["acme-04", "gym-01", "lease-old", "other-owner", "disconnected", "missing"])
def test_reader_serves_only_in_scope_email(monkeypatch, email_id):
    async def resolve_session(_request, _response):
        return harness.SESSION_ID

    monkeypatch.setattr(main, "_resolve_session", resolve_session)

    async def scenario():
        db, fakes = await _reader_db()
        monkeypatch.setattr(main, "get_db", lambda: db)
        with harness.fake_google(main, fakes):
            return await main.get_email(email_id, None, None)

    if email_id == "acme-04":
        assert asyncio.run(scenario())["id"] == "acme-04"
    else:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(scenario())
        assert exc.value.status_code == 404


def test_search_reads_past_the_first_1000_emails(monkeypatch):
    sent = datetime.now(UTC) - timedelta(days=1)
    subjects = [f"Weekly status update {i}" for i in range(1200)]
    subjects[1150] = "Zebra crossing permit approved"
    vectors = main.encode(subjects)  # looked up at call time, so this is the tests' fake encoder
    docs = [
        {"id": f"bulk-{i}", "owner_session": harness.SESSION_ID, "accountEmail": PRIMARY,
         "message_timestamp": sent, "subject": s, "snippet": "", "sender": "city@example.com",
         "emb_subject": vectors[i].tolist(), "emb_body": vectors[i].tolist()}
        for i, s in enumerate(subjects)
    ]
    query = "zebra crossing permit"

    async def scenario():
        db = AsyncMongoMockClient()["test"]
        await db["emails"].insert_many(docs)
        await db["settings"].insert_one({"_id": main.ACCOUNTS_DOC_ID, "accounts": [
            {"email": PRIMARY, "session_id": harness.SESSION_ID, "token_json": "{}"}]})
        monkeypatch.setattr(main, "get_db", lambda: db)
        return await main._semantic_search(query, harness.SESSION_ID, intent=agent_search._fallback(query))

    result = asyncio.run(scenario())
    assert "bulk-1150" in [r["id"] for r in result["results"]]


def test_seeded_mock_emails_land_inside_the_window(monkeypatch):
    async def resolve_session(_request, _response):
        return harness.SESSION_ID

    monkeypatch.setattr(main, "_resolve_session", resolve_session)

    async def scenario():
        db = AsyncMongoMockClient()["test"]
        monkeypatch.setattr(main, "get_db", lambda: db)
        inserted = (await main.seed_emails(None, None))["inserted"]
        visible = await db["emails"].count_documents(main.eligible_filter(harness.SESSION_ID, []))
        return inserted, visible

    inserted, visible = asyncio.run(scenario())
    assert inserted > 0 and visible == inserted
