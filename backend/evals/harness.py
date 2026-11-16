"""Shared evaluation harness: fixtures, a fake Gmail service, and the question runner.

Fixtures go through the real sync path (`_sync_account_bulk`) and each question goes
through the real chat path (`_chat_stream`). Only these are replaced:
- MongoDB, by an in-memory mongomock database;
- Gmail, by FakeGmail below;
- answer generation, which retrieval scoring does not need;
- offline only: Gemini query understanding, by the question's `intent` merged onto the
  app's own no-key fallback. Gemini rerank is skipped by the app itself when no key is set.

emails.json       synthetic messages: id, thread, account, age_days, from, subject, labels,
                  text or html (html = an HTML-only message), optional to and attachments.
questions.jsonl   one question per line: id, split (dev|heldout), category, question,
                  expect (found|empty|clarify|unanswerable), relevant_ids, and optional
                  forbidden_ids, filters, intent, history, context_ids, open_email_id,
                  expected_facts.
"""

from __future__ import annotations

import base64
import contextlib
import html as html_lib
import importlib
import inspect
import json
import os
import re
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from pathlib import Path
from unittest import mock

import httplib2
from googleapiclient.errors import HttpError
from mongomock.collection import BulkOperationBuilder
from mongomock_motor import AsyncMongoMockClient

# mongomock 4.3 predates the `sort` argument pymongo 4.11+ passes for bulk updates. The app
# never sets it, so accept and drop it; this does nothing once mongomock supports it.
if "sort" not in inspect.signature(BulkOperationBuilder.add_update).parameters:
    _add_update = BulkOperationBuilder.add_update

    def _add_update_without_sort(self, *args, sort=None, **kwargs):
        if sort is not None:
            raise NotImplementedError("mongomock cannot apply a sorted bulk update")
        return _add_update(self, *args, **kwargs)

    BulkOperationBuilder.add_update = _add_update_without_sort

EVALS_DIR = Path(__file__).parent
SESSION_ID = "eval-session"
WINDOW_DAYS = 30
TOP_K = 5
ANSWER_MODES = {"answer", "extract"}


def import_main(live: bool = False):
    """Import the app with production secrets blanked out.

    db.py calls load_dotenv(), which never overrides variables that are already set, so
    setting them to "" keeps backend/.env's database URI (and, offline, the Gemini key) out.
    """
    os.environ["MONGODB_URI"] = ""
    if not live:
        os.environ["GEMINI_API_KEY"] = ""
    return importlib.import_module("main")


def load_emails() -> list[dict]:
    return json.loads((EVALS_DIR / "emails.json").read_text(encoding="utf-8"))


def load_questions() -> list[dict]:
    lines = (EVALS_DIR / "questions.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


# ── Fake Gmail ────────────────────────────────────────────────────────────────


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii")


def _snippet(fx: dict) -> str:
    """Approximate Gmail's snippet: the first ~200 characters of visible text."""
    text = fx.get("text")
    if text is None:
        text = re.sub(r"<(style|head)\b.*?</\1>", " ", fx["html"], flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r"<[^>]+>", " ", text)
    return " ".join(html_lib.unescape(text).split())[:200]


def to_gmail_message(fx: dict, now: datetime) -> dict:
    """Build a `messages.get(format="full")` response for one fixture."""
    sent_at = now - timedelta(days=fx["age_days"])
    headers = [
        {"name": "From", "value": fx["from"]},
        {"name": "To", "value": fx.get("to", fx["account"])},
        {"name": "Subject", "value": fx["subject"]},
        {"name": "Date", "value": format_datetime(sent_at)},
    ]
    if "html" in fx:
        body_part = {"mimeType": "text/html", "body": {"data": _b64(fx["html"])}}
    else:
        body_part = {"mimeType": "text/plain", "body": {"data": _b64(fx["text"])}}

    attachments = fx.get("attachments") or []
    if attachments:
        parts = [body_part] + [
            {
                "mimeType": a["mimeType"],
                "filename": a["filename"],
                "body": {"attachmentId": f"{fx['id']}-att-{i}", "size": 20480},
            }
            for i, a in enumerate(attachments)
        ]
        payload = {"mimeType": "multipart/mixed", "headers": headers, "body": {"size": 0}, "parts": parts}
    else:
        payload = {**body_part, "headers": headers}

    return {
        "id": fx["id"],
        "threadId": fx["thread"],
        "labelIds": fx["labels"],
        "snippet": _snippet(fx),
        "internalDate": str(int(sent_at.timestamp() * 1000)),
        "payload": payload,
    }


class _Call:
    def __init__(self, value=None, error: Exception | None = None):
        self._value = value
        self._error = error

    def execute(self):
        if self._error:
            raise self._error
        return self._value


def _not_found() -> HttpError:
    body = b'{"error": {"code": 404, "message": "Requested entity was not found."}}'
    return HttpError(httplib2.Response({"status": 404}), body)


class FakeGmail:
    """The users().messages().list/get calls the sync and backfill paths make.

    Supports an empty `q` and `newer_than:<N>d`; anything else raises.
    """

    def __init__(self, messages: list[dict]):
        self._by_id = {m["id"]: m for m in messages}
        # Gmail lists newest first and leaves out Spam/Trash unless includeSpamTrash is set.
        listed = [m for m in messages if not {"SPAM", "TRASH"} & set(m["labelIds"])]
        self._listed = sorted(listed, key=lambda m: int(m["internalDate"]), reverse=True)

    def users(self):
        return self

    def messages(self):
        return self

    def list(self, userId, maxResults=100, q="", pageToken=None, **_):
        listed = self._listed
        if q:
            match = re.fullmatch(r"newer_than:(\d+)d", q)
            if not match:
                raise NotImplementedError(f"FakeGmail does not support q={q!r}")
            cutoff = datetime.now(UTC) - timedelta(days=int(match.group(1)))
            listed = [m for m in listed if int(m["internalDate"]) >= cutoff.timestamp() * 1000]
        start = int(pageToken or 0)
        page = listed[start : start + maxResults]
        out = {"messages": [{"id": m["id"], "threadId": m["threadId"]} for m in page]}
        if start + maxResults < len(listed):
            out["nextPageToken"] = str(start + maxResults)
        return _Call(out)

    def get(self, userId, id, format="full", **_):
        message = self._by_id.get(id)
        if message is None:
            return _Call(error=_not_found())
        if format == "minimal":
            message = {k: v for k, v in message.items() if k != "payload"}
        return _Call(message)


class FakeCredentials:
    valid = True
    expired = False
    refresh_token = None

    def __init__(self, account: str):
        self.account = account


@contextlib.contextmanager
def fake_google(main, fakes: dict[str, FakeGmail]):
    """Send the app's Gmail client and stored-credential parsing to the fakes."""

    async def credentials_from_row(row):
        return FakeCredentials(row["email"])

    def build(*_args, credentials, **_kwargs):
        return fakes[credentials.account]

    with mock.patch.object(main, "build", build), mock.patch.object(main, "_credentials_from_row", credentials_from_row):
        yield


async def ingest(main, db, emails: list[dict], now: datetime) -> dict[str, FakeGmail]:
    """Run the fixtures through the same sync function `/emails/sync` uses.

    Returns the fake Gmail service per account, for tests that make further calls.
    """
    by_account: dict[str, list[dict]] = {}
    for fx in emails:
        by_account.setdefault(fx["account"], []).append(to_gmail_message(fx, now))
    fakes = {account: FakeGmail(msgs) for account, msgs in by_account.items()}

    # Rows with a token count as connected accounts. The token is a placeholder: fake_google
    # replaces credential parsing, so nothing reaches Google.
    await db["settings"].update_one(
        {"_id": main.ACCOUNTS_DOC_ID},
        {"$set": {"accounts": [{"email": a, "session_id": SESSION_ID, "token_json": "{}"} for a in fakes]}},
        upsert=True,
    )

    with fake_google(main, fakes):
        for account in fakes:
            await main._sync_account_bulk(
                db, account, FakeCredentials(account), max_results=200, owner_session=SESSION_ID
            )
    return fakes


# ── Running and scoring questions ─────────────────────────────────────────────


async def _skip_generation(*_args, **_kwargs):
    for _ in ():
        yield ""


def score(q: dict, mode: str | None, returned: list[str], used: str | None, ages: dict) -> dict:
    """Check one question's outcome. `used` is the email an answer/extract reply is built from."""
    shown = list(dict.fromkeys(returned + ([used] if used else [])))
    problems = []
    expect = q["expect"]
    hit = None
    if expect == "found":
        picked = ([used] if used else []) if mode in ANSWER_MODES else returned
        hit = bool(set(q["relevant_ids"]) & set(picked))
        if not hit:
            problems.append(f"missed {q['relevant_ids']}, got {picked[:3]}")
    elif expect == "empty" and shown:
        problems.append(f"expected no results, got {shown[:3]}")
    elif expect == "clarify" and mode != "clarify":
        problems.append(f"expected a clarifying question, got mode={mode} using {used}")

    out_of_window = [i for i in shown if ages.get(i, 0) > WINDOW_DAYS]
    if out_of_window:
        problems.append(f"older than {WINDOW_DAYS} days: {out_of_window}")
    forbidden = [i for i in shown if i in set(q.get("forbidden_ids", []))]
    if forbidden:
        problems.append(f"forbidden: {forbidden}")

    return {
        "passed": not problems,
        "hit": hit,
        "detail": "; ".join(problems),
        "out_of_window": out_of_window,
        "forbidden_hits": forbidden,
    }


async def run_question(main, db, q: dict, ages: dict, fakes: dict[str, FakeGmail], *, live: bool) -> dict:
    filters = main.FilterOptions(**q["filters"]) if q.get("filters") else None
    context = None
    if q.get("context_ids"):
        # What the browser echoes back from the previous turn's meta event.
        context = main.ConversationContext(
            result_ids=q["context_ids"],
            active_email_id=q["context_ids"][0],
            search_key=main._conversation_search_key(TOP_K, filters.model_dump() if filters else None),
        )
    req = main.ChatRequest(
        messages=[*q.get("history", []), {"role": "user", "content": q["question"]}],
        top_k=TOP_K,
        filters=filters,
        active_email_id=q.get("open_email_id"),
        context=context,
    )

    fallback = importlib.import_module("agent_search")._fallback

    async def simulated_understanding(query_text, history=None):
        return {**fallback(query_text), **q.get("intent", {})}

    with contextlib.ExitStack() as stack:
        stack.enter_context(fake_google(main, fakes))  # answer modes fetch bodies from Gmail
        stack.enter_context(mock.patch.object(main, "get_db", lambda: db))
        stack.enter_context(mock.patch.object(main, "agent_stream_call", _skip_generation))
        if not live:
            stack.enter_context(mock.patch.object(main, "understand_query_async", simulated_understanding))
        events = [json.loads(chunk.removeprefix("data: ")) async for chunk in main._chat_stream(req, SESSION_ID)]

    row = {"id": q["id"], "split": q["split"], "category": q["category"], "expect": q["expect"]}
    meta = next((e for e in events if e.get("type") == "meta"), None)
    if meta is None:
        error = next((e.get("detail") for e in events if e.get("type") == "error"), "no meta event")
        return {**row, "mode": None, "returned": [], "used": None, "passed": False, "hit": None,
                "detail": f"error: {error}", "out_of_window": [], "forbidden_hits": [], "error": error}

    mode = meta.get("mode")
    returned = [r["id"] for r in meta.get("results") or []]
    used = (meta.get("context") or {}).get("active_email_id") if mode in ANSWER_MODES else None
    return {**row, "mode": mode, "returned": returned, "used": used, **score(q, mode, returned, used, ages)}


async def run_all(main, *, live: bool, now: datetime | None = None) -> list[dict]:
    now = now or datetime.now(UTC)
    emails = load_emails()
    ages = {e["id"]: e["age_days"] for e in emails}
    db = AsyncMongoMockClient()["sherlock_eval"]
    fakes = await ingest(main, db, emails, now)
    return [await run_question(main, db, q, ages, fakes, live=live) for q in load_questions()]
