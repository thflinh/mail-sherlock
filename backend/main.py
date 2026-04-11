from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from contextlib import asynccontextmanager
from typing import Literal, Optional
import html
import json
import numpy as np
import os
from pathlib import Path
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError as GmailHttpError
import asyncio
import base64
import concurrent.futures
import logging
import time
from datetime import datetime, timezone
from pymongo.errors import PyMongoError

logger = logging.getLogger(__name__)

from db import connect_db, close_db, get_db
from embeddings import (
    add_embeddings_inplace,
    cosine_similarity,
    document_search_text,
    embeddings_ready,
    field_embeddings_ready,
    encode,
    warmup,
)
from agent_search import understand_query, rerank, synthesize_answer

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
CREDENTIALS_FILE = Path(__file__).parent / "credentials.json"  # local dev fallback
TOKEN_FILE = Path(__file__).parent / "token.json"               # local dev fallback

SETTINGS_DOC_ID = "oauth"
TOKEN_DOC_ID = "oauth_token"
ACCOUNTS_DOC_ID = "gmail_accounts"
LANDING_FILE = Path(__file__).parent / "static" / "index.html"
OAUTH_SUCCESS_FILE = Path(__file__).parent / "static" / "oauth_success.html"
OAUTH_ERROR_FILE = Path(__file__).parent / "static" / "oauth_error.html"


def _gmail_list_query_after_epoch(last_sync_at: Optional[int]) -> str:
    """Gmail `messages().list(q=...)` filter for mail after last sync. Empty = no filter (initial backfill).

    Gmail documents `after:YYYY/MM/DD`. Using `after:<unix seconds>` is undocumented and often returns
    **no messages**, so sync stored 0 emails while still advancing `last_sync_at`.
    """
    if last_sync_at is None:
        return ""
    try:
        ts = int(last_sync_at)
    except (TypeError, ValueError):
        return ""
    if ts <= 0:
        return ""
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return f"after:{dt.year}/{dt.month:02d}/{dt.day:02d}"


def _load_credentials_config() -> dict:
    """Load Google OAuth client config from env var, falling back to local file."""
    raw = os.getenv("GOOGLE_CREDENTIALS_JSON", "").strip()
    if raw:
        return json.loads(raw)
    if CREDENTIALS_FILE.exists():
        return json.loads(CREDENTIALS_FILE.read_text())
    raise RuntimeError(
        "Google OAuth credentials not found. "
        "Set GOOGLE_CREDENTIALS_JSON env var or place credentials.json in the backend folder."
    )


async def _load_token(db) -> Optional[Credentials]:
    """Load OAuth token from MongoDB, falling back to local token.json for dev."""
    doc = await db["settings"].find_one({"_id": TOKEN_DOC_ID})
    if doc and doc.get("token_json"):
        return Credentials.from_authorized_user_info(json.loads(doc["token_json"]), SCOPES)
    if TOKEN_FILE.exists():
        return Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    return None


async def _save_token(db, creds: Credentials) -> None:
    """Persist OAuth token to MongoDB so it survives server restarts."""
    await db["settings"].update_one(
        {"_id": TOKEN_DOC_ID},
        {"$set": {"token_json": creds.to_json()}},
        upsert=True,
    )


async def _ensure_accounts_migrated(db) -> None:
    """One-time: legacy single token + oauth doc → gmail_accounts[]; tag legacy emails."""
    doc = await db["settings"].find_one({"_id": ACCOUNTS_DOC_ID})
    if doc and isinstance(doc.get("accounts"), list) and len(doc["accounts"]) > 0:
        return

    tok_doc = await db["settings"].find_one({"_id": TOKEN_DOC_ID})
    oauth_doc = await db["settings"].find_one({"_id": SETTINGS_DOC_ID}) or {}
    token_json = (tok_doc or {}).get("token_json")
    if not token_json and TOKEN_FILE.exists():
        token_json = TOKEN_FILE.read_text()
    if not token_json:
        return

    creds = Credentials.from_authorized_user_info(json.loads(token_json), SCOPES)
    email = (oauth_doc.get("gmail_address") or "").strip()
    if not email:
        try:
            if creds.expired and creds.refresh_token:
                creds.refresh(GoogleRequest())
            svc = build("gmail", "v1", credentials=creds)
            prof = svc.users().getProfile(userId="me").execute()
            email = (prof.get("emailAddress") or "").strip()
        except Exception:
            pass
    if not email:
        logger.warning("Migration: could not resolve Gmail address; user should reconnect.")
        return

    last_sync = oauth_doc.get("last_sync_at")
    await db["settings"].update_one(
        {"_id": ACCOUNTS_DOC_ID},
        {
            "$set": {
                "accounts": [
                    {
                        "email": email,
                        "token_json": creds.to_json(),
                        "last_sync_at": last_sync,
                    }
                ]
            }
        },
        upsert=True,
    )
    try:
        await db["emails"].update_many(
            {"accountEmail": {"$exists": False}},
            {"$set": {"accountEmail": email}},
        )
    except PyMongoError:
        pass


async def _get_gmail_account_rows(db) -> list[dict]:
    await _ensure_accounts_migrated(db)
    doc = await db["settings"].find_one({"_id": ACCOUNTS_DOC_ID})
    rows = doc.get("accounts") if doc else None
    if not isinstance(rows, list):
        return []
    return [r for r in rows if isinstance(r, dict) and r.get("token_json")]


async def _list_connected_emails(db) -> list[str]:
    rows = await _get_gmail_account_rows(db)
    out = []
    for r in rows:
        e = (r.get("email") or "").strip()
        if e and e not in out:
            out.append(e)
    return out


async def _upsert_gmail_account(db, email: str, creds: Credentials) -> None:
    email = (email or "").strip()
    if not email:
        raise ValueError("missing email")
    await _ensure_accounts_migrated(db)
    doc = await db["settings"].find_one({"_id": ACCOUNTS_DOC_ID})
    rows = list(doc.get("accounts") or []) if doc else []
    if not isinstance(rows, list):
        rows = []
    replaced = False
    new_rows = []
    for r in rows:
        if isinstance(r, dict) and (r.get("email") or "").strip() == email:
            new_rows.append({**r, "email": email, "token_json": creds.to_json()})
            replaced = True
        else:
            new_rows.append(r)
    if not replaced:
        new_rows.append({"email": email, "token_json": creds.to_json(), "last_sync_at": None})
    await db["settings"].update_one(
        {"_id": ACCOUNTS_DOC_ID},
        {"$set": {"accounts": new_rows}},
        upsert=True,
    )


async def _credentials_from_row(row: dict) -> Optional[Credentials]:
    tj = row.get("token_json")
    if not tj:
        return None
    return Credentials.from_authorized_user_info(json.loads(tj), SCOPES)


async def _persist_refreshed_credentials(db, email: str, creds: Credentials) -> None:
    rows = await _get_gmail_account_rows(db)
    email = email.strip()
    new_rows = []
    for r in rows:
        if (r.get("email") or "").strip() == email:
            new_rows.append({**r, "token_json": creds.to_json()})
        else:
            new_rows.append(r)
    await db["settings"].update_one(
        {"_id": ACCOUNTS_DOC_ID},
        {"$set": {"accounts": new_rows}},
        upsert=True,
    )


def _oauth_error_html(message: str, status_code: int = 400) -> HTMLResponse:
    try:
        body = OAUTH_ERROR_FILE.read_text(encoding="utf-8")
        body = body.replace("###ERROR_MESSAGE###", html.escape(message))
    except Exception:
        # Fallback inline page if the file is missing
        safe = html.escape(message)
        body = (
            f"<!DOCTYPE html><html><head><meta charset='UTF-8'>"
            f"<title>Sign-in error</title></head>"
            f"<body style='font-family:system-ui;background:#0f0f10;color:#e5e5e5;"
            f"display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>"
            f"<div style='text-align:center;max-width:420px'>"
            f"<h1>Sign-in failed</h1><p style='color:#dc2626'>{safe}</p>"
            f"<p><a href='/auth/login' style='color:#9b72cf'>Try again →</a></p>"
            f"</div></body></html>"
        )
    return HTMLResponse(content=body, status_code=status_code)


async def _get_stored_gmail_address(db) -> Optional[str]:
    """Primary connected Gmail (first account) for backward-compatible API fields."""
    emails = await _list_connected_emails(db)
    if emails:
        return emails[0]
    doc = await db["settings"].find_one({"_id": SETTINGS_DOC_ID})
    if not doc:
        return None
    addr = doc.get("gmail_address")
    return addr.strip() if isinstance(addr, str) and addr.strip() else None


def _has_attachment(payload: dict) -> bool:
    """Return True if the Gmail message payload contains at least one file attachment."""
    for part in payload.get("parts") or []:
        if part.get("filename") and part.get("body", {}).get("size", 0) > 0:
            return True
        if part.get("mimeType", "").startswith("multipart/") and _has_attachment(part):
            return True
    return False


def _raw_message_to_doc(raw: dict, account_email: str) -> dict:
    payload = raw.get("payload", {})
    headers = {h["name"]: h["value"] for h in payload.get("headers", [])}
    body = _extract_body(payload)
    label_ids = raw.get("labelIds", [])
    return {
        "id": raw.get("id", ""),
        "threadId": raw.get("threadId", ""),
        "subject": headers.get("Subject", "(no subject)"),
        "sender": headers.get("From", ""),
        "date": headers.get("Date", ""),
        "snippet": raw.get("snippet", ""),
        "body": body[:2000],
        "isUnread": "UNREAD" in label_ids,
        "hasAttachment": _has_attachment(payload),
        "accountEmail": account_email,
    }


async def _set_account_last_sync(db, account_email: str, ts: int) -> None:
    rows = await _get_gmail_account_rows(db)
    new_rows = []
    for r in rows:
        if (r.get("email") or "").strip() == account_email.strip():
            new_rows.append({**r, "last_sync_at": ts})
        else:
            new_rows.append(r)
    await db["settings"].update_one(
        {"_id": ACCOUNTS_DOC_ID},
        {"$set": {"accounts": new_rows}},
        upsert=True,
    )


async def _incremental_sync_account(db, account_email: str, creds: Credentials) -> int:
    """Incremental fetch for one Gmail account. Returns number of new messages stored."""
    account_email = account_email.strip()
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            try:
                creds.refresh(GoogleRequest())
                await _persist_refreshed_credentials(db, account_email, creds)
            except Exception as exc:
                logger.warning("Auto-sync: token refresh failed for %s: %s", account_email, exc)
                return 0
        else:
            return 0

    rows = await _get_gmail_account_rows(db)
    last_sync = None
    for r in rows:
        if (r.get("email") or "").strip() == account_email:
            last_sync = r.get("last_sync_at")
            break

    try:
        service = build("gmail", "v1", credentials=creds)
        q = _gmail_list_query_after_epoch(last_sync)
        response = service.users().messages().list(userId="me", maxResults=100, q=q).execute()
        messages = response.get("messages", [])

        if not messages:
            await _set_account_last_sync(db, account_email, int(time.time()))
            return 0

        emails = []
        for msg in messages:
            raw = service.users().messages().get(userId="me", id=msg["id"], format="full").execute()
            emails.append(_raw_message_to_doc(raw, account_email))

        add_embeddings_inplace(emails)

        for email in emails:
            await db["emails"].update_one({"id": email["id"]}, {"$set": email}, upsert=True)

        await _set_account_last_sync(db, account_email, int(time.time()))
        logger.info("Auto-sync [%s]: upserted %d new email(s).", account_email, len(emails))
        return len(emails)
    except Exception as exc:
        logger.warning("Auto-sync failed for %s: %s", account_email, exc)
        return 0


async def _incremental_sync(db) -> int:
    """Fetch only emails newer than each account's last sync. Returns total new messages."""
    rows = await _get_gmail_account_rows(db)
    if not rows:
        return 0
    total = 0
    for row in rows:
        email = (row.get("email") or "").strip()
        if not email:
            continue
        creds = await _credentials_from_row(row)
        if not creds:
            continue
        total += await _incremental_sync_account(db, email, creds)
    return total


async def _background_sync_loop():
    """Check for new emails every 10 minutes while the server is running."""
    await asyncio.sleep(60)  # wait 60 s after startup before first auto-sync
    while True:
        try:
            db = get_db()
            await _incremental_sync(db)
        except Exception as exc:
            logger.warning("Background sync loop error: %s", exc)
        await asyncio.sleep(10 * 60)  # 10 minutes


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()
    asyncio.get_event_loop().run_in_executor(None, warmup)  # warm up embedding model
    task = asyncio.create_task(_background_sync_loop())
    yield
    task.cancel()
    await close_db()


app = FastAPI(title="mail-sherlock", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_STATIC_DIR = Path(__file__).parent / "static"
if (_STATIC_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(_STATIC_DIR / "assets")), name="assets")


_flows = {}


@app.get("/ready")
def ready():
    return {"status": "ok"}


@app.get("/status")
async def app_status(response: Response):
    """Returns auth state and email count so the frontend knows what setup step the user is on."""
    response.headers["Cache-Control"] = "no-store"
    db = get_db()
    accounts = await _list_connected_emails(db)
    gmail_auth_email = accounts[0] if accounts else await _get_stored_gmail_address(db)
    try:
        email_count = await db["emails"].count_documents({})
    except PyMongoError:
        email_count = 0
    return {
        "gmailAuthEmail": gmail_auth_email,
        "accounts": accounts,
        "emailCount": email_count,
    }


@app.get("/", response_class=HTMLResponse)
def landing_page():
    """Dark landing page: product intro + Gmail OAuth CTA."""
    if not LANDING_FILE.exists():
        return HTMLResponse(
            "<html><body>Landing page missing (backend/static/index.html).</body></html>",
            status_code=500,
        )
    return HTMLResponse(LANDING_FILE.read_text(encoding="utf-8"))


@app.get("/auth/login")
def auth_login():
    """Redirects the user to Google's OAuth consent screen."""
    try:
        config = _load_credentials_config()
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    flow = Flow.from_client_config(
        config,
        scopes=SCOPES,
        redirect_uri=os.getenv("BACKEND_URL", "http://localhost:8000").rstrip("/") + "/auth/callback",
    )
    # select_account: lets users pick a *different* Google identity when adding another mailbox
    # (otherwise Google often re-approves the same session and only one account is stored).
    auth_url, state = flow.authorization_url(
        prompt="select_account consent",
        access_type="offline",
    )
    _flows[state] = flow
    return RedirectResponse(auth_url)


@app.get("/auth/callback")
async def auth_callback(code: Optional[str] = None, state: Optional[str] = None):
    """Google redirects here with ?code=...&state=... after the user grants access."""
    if not code or not state:
        return _oauth_error_html(
            "This page only works when Google redirects here after you approve access. "
            'Open http://localhost:8000/ and click "Authorize Gmail", or go to /auth/login.',
        )
    flow = _flows.pop(state, None)
    if not flow:
        return _oauth_error_html(
            "The sign-in session expired (for example the API restarted). "
            "Go to http://localhost:8000/auth/login and try again.",
        )
    try:
        flow.fetch_token(code=code)
    except Exception as e:
        return _oauth_error_html(f"Could not complete sign-in: {e}")
    try:
        creds = flow.credentials
        service = build("gmail", "v1", credentials=creds)
        profile = service.users().getProfile(userId="me").execute()
        addr = (profile.get("emailAddress") or "").strip()
        if not addr:
            return _oauth_error_html("Could not read your Gmail address from Google.", status_code=500)
        await _upsert_gmail_account(get_db(), addr, creds)
    except Exception as e:
        logger.error("Failed to save OAuth token: %s", e)
        return _oauth_error_html(f"Authenticated but could not save credentials: {e}", status_code=500)
    try:
        body = OAUTH_SUCCESS_FILE.read_text(encoding="utf-8")
    except Exception:
        body = (
            "<!DOCTYPE html><html><head><meta charset='UTF-8'>"
            "<meta http-equiv='refresh' content='2;url=/#/dashboard'>"
            "<title>Connected</title></head>"
            "<body style='font-family:system-ui;background:#0f0f10;color:#e5e5e5;"
            "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>"
            "<div style='text-align:center'><h1>Gmail connected!</h1>"
            "<p>Redirecting to dashboard…</p>"
            "<p><a href='/#/dashboard' style='color:#9b72cf'>Go to Dashboard →</a></p>"
            "</div></body></html>"
        )
    return HTMLResponse(content=body, status_code=200)


class QueryRequest(BaseModel):
    query: str
    top_k: int = 5


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class FilterOptions(BaseModel):
    has_attachment: bool = False
    unread_only: bool = False
    account_email: Optional[str] = None


class ChatRequest(BaseModel):
    """Multi-turn chat: the server embeds all user lines together for context-aware search."""

    messages: list[ChatMessage]
    top_k: int = 5
    filters: Optional[FilterOptions] = None


def _latest_user_message(messages: list[ChatMessage]) -> str:
    """Return the most recent user message — this is the active search intent."""
    for m in reversed(messages):
        if m.role == "user" and m.content.strip():
            return m.content.strip()
    return ""


async def _semantic_search(query_text: str, top_k: int = 5, history: list[dict] | None = None, filters: dict | None = None) -> dict:
    db = get_db()
    try:
        emails = await db["emails"].find({}, {"_id": 0}).to_list(length=1000)
    except PyMongoError as e:
        raise HTTPException(
            status_code=503,
            detail=f"MongoDB unavailable (check MONGODB_URI, network, TLS): {e}",
        ) from e

    gmail_auth_email = await _get_stored_gmail_address(db)
    connected_accounts = await _list_connected_emails(db)
    q = query_text.strip()
    if not q:
        return {"results": [], "gmailAuthEmail": gmail_auth_email, "accounts": connected_accounts}

    if not emails:
        return {"results": [], "gmailAuthEmail": gmail_auth_email, "accounts": connected_accounts}

    try:
        # Use Gemini to understand the query intent (with conversation history for follow-ups)
        intent = understand_query(q, history=history)

        # If Gemini needs clarification, return the question without running a search
        if intent.get("needs_clarification"):
            return {
                "results": [],
                "gmailAuthEmail": gmail_auth_email,
                "accounts": connected_accounts,
                "intent": intent,
                "clarification": intent.get("clarifying_question"),
            }

        search_q = intent.get("search_query") or q
        keywords = [kw.lower() for kw in intent.get("keywords") or []]
        sender_hint = (intent.get("sender") or "").lower()
        date_hint = intent.get("date_hint")

        candidates = emails

        # Apply client-requested filter chips (has_attachment / unread_only / account)
        if filters:
            ae = (filters.get("account_email") or "").strip()
            if ae:
                filtered = [e for e in candidates if e.get("accountEmail") == ae]
                candidates = filtered
            if filters.get("has_attachment"):
                filtered = [e for e in candidates if e.get("hasAttachment")]
                if filtered:
                    candidates = filtered
            if filters.get("unread_only"):
                filtered = [e for e in candidates if e.get("isUnread")]
                if filtered:
                    candidates = filtered

        # Filter by sender if Gemini extracted one
        if sender_hint:
            filtered = [e for e in candidates if sender_hint in e.get("sender", "").lower()]
            if filtered:
                candidates = filtered

        # Filter by date if Gemini extracted a time range
        if date_hint:
            from datetime import datetime, timedelta, timezone
            from email.utils import parsedate_to_datetime
            now = datetime.now(timezone.utc)
            delta = {"last_week": timedelta(days=7), "last_month": timedelta(days=30), "last_year": timedelta(days=365)}.get(date_hint)
            if delta:
                cutoff = now - delta
                def _parse_date(s):
                    try:
                        return parsedate_to_datetime(s)
                    except Exception:
                        return datetime.min.replace(tzinfo=timezone.utc)
                filtered = [e for e in candidates if _parse_date(e.get("date", "")) >= cutoff]
                if filtered:
                    candidates = filtered

        if not candidates:
            return {
                "results": [],
                "gmailAuthEmail": gmail_auth_email,
                "accounts": connected_accounts,
                "intent": intent,
            }

        query_vec = encode([search_q])[0]
        focus = (intent.get("search_focus") or "any").lower()

        if field_embeddings_ready(candidates):
            subj_vecs = np.asarray([e["emb_subject"] for e in candidates], dtype=np.float32)
            body_vecs = np.asarray([e["emb_body"]    for e in candidates], dtype=np.float32)
            subj_scores = cosine_similarity(query_vec, subj_vecs)
            body_scores = cosine_similarity(query_vec, body_vecs)
            if focus == "subject":
                sem_scores = 0.8 * subj_scores + 0.2 * body_scores
            elif focus == "body":
                sem_scores = 0.2 * subj_scores + 0.8 * body_scores
            elif focus == "sender":
                sem_scores = subj_scores  # sender already hard-filtered above
            else:
                sem_scores = 0.5 * subj_scores + 0.5 * body_scores
        elif embeddings_ready(candidates):
            email_vecs = np.asarray([e["embedding"] for e in candidates], dtype=np.float32)
            sem_scores = cosine_similarity(query_vec, email_vecs)
        else:
            bodies = [document_search_text(e) for e in candidates]
            sem_scores = cosine_similarity(query_vec, encode(bodies))

        # ── BM25 hybrid scoring ──────────────────────────────────────────────
        # Semantic search misses exact matches (order numbers, names, IDs).
        # BM25 covers those gaps; blend 70% semantic + 30% keyword.
        from rank_bm25 import BM25Okapi
        tokenized_corpus = [
            (e.get("subject", "") + " " + e.get("body", "")).lower().split()
            for e in candidates
        ]
        bm25 = BM25Okapi(tokenized_corpus)
        bm25_scores = np.array(bm25.get_scores(search_q.lower().split()), dtype=np.float32)

        sem_max  = float(sem_scores.max())  or 1.0
        bm25_max = float(bm25_scores.max()) or 1.0
        scores = (
            0.7 * (sem_scores  / sem_max) +
            0.3 * (bm25_scores / bm25_max)
        )

        # Boost score for emails containing extracted keywords
        if keywords:
            for idx, email in enumerate(candidates):
                text = (email.get("subject", "") + " " + email.get("body", "")).lower()
                boost = sum(0.15 for kw in keywords if kw in text)
                scores[idx] += boost

        # Fetch top-15 by cosine score, then re-rank with Gemini for true relevance
        pre_k = min(15, len(candidates))
        top_indices = np.argsort(scores)[::-1][:pre_k]
        pre_results = []
        for i in top_indices:
            row = {k: v for k, v in candidates[i].items() if k != "embedding"}
            row["score"] = round(float(scores[i]), 4)
            pre_results.append(row)

        results = rerank(q, pre_results, top_k=top_k)
        return {
            "results": results,
            "gmailAuthEmail": gmail_auth_email,
            "accounts": connected_accounts,
            "intent": intent,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {e}") from e


@app.post("/ask")
async def ask(req: QueryRequest):
    return await _semantic_search(req.query, req.top_k)


@app.post("/chat")
async def chat(req: ChatRequest):
    query_text = _latest_user_message(req.messages)
    if not query_text:
        raise HTTPException(
            status_code=400,
            detail="Add at least one user message with text.",
        )
    # Pass prior turns as history so Gemini can resolve follow-ups correctly
    history = [{"role": m.role, "content": m.content} for m in req.messages[:-1]]
    filters = req.filters.model_dump() if req.filters else None
    out = await _semantic_search(query_text, req.top_k, history=history, filters=filters)

    _NEGATIVE_PREFIXES = (
        "none of", "no email", "there is no", "there are no",
        "i could not", "i couldn't", "no relevant", "based on the provided",
    )

    if out.get("clarification"):
        out["reply"] = out["clarification"]
    else:
        n = len(out.get("results", []))
        intent = out.get("intent", {})
        topic = intent.get("topic") or query_text
        answer = synthesize_answer(query_text, out.get("results", []))
        # Discard any Gemini response that incorrectly says nothing was found
        # when results exist, or that is a truncated/negative non-answer.
        if answer and not answer.lower().startswith(_NEGATIVE_PREFIXES):
            out["reply"] = answer
            out["answer"] = answer
        elif n > 0:
            out["reply"] = f'I found **{n}** email{"s" if n != 1 else ""} related to: {topic}'
        else:
            out["reply"] = "I couldn't find any emails matching that description. Try rephrasing or adding more details."
    return out


@app.get("/health")
async def health():
    """Quick check that the API and MongoDB are usable."""
    db = get_db()
    try:
        await db.command("ping")
        return {"ok": True, "database": "up"}
    except PyMongoError as e:
        raise HTTPException(
            status_code=503,
            detail=f"Database down: {e}",
        ) from e


def _extract_body(payload: dict) -> str:
    """Safely extract plain-text body from a Gmail message payload (handles nested parts)."""
    parts = payload.get("parts") or []
    for part in parts:
        mime = part.get("mimeType", "")
        if mime == "text/plain":
            data = part.get("body", {}).get("data")
            if data:
                return base64.urlsafe_b64decode(data).decode("utf-8", errors="ignore")
        # recurse into multipart/* containers
        if mime.startswith("multipart/"):
            nested = _extract_body(part)
            if nested:
                return nested
    # top-level body fallback (non-multipart messages)
    data = payload.get("body", {}).get("data")
    if data:
        return base64.urlsafe_b64decode(data).decode("utf-8", errors="ignore")
    return ""


async def _sync_account_bulk(db, account_email: str, creds: Credentials, max_results: int = 2000, incremental: bool = False) -> int:
    """Fetch new messages for one Gmail account and upsert into MongoDB.

    When incremental=True (background auto-sync), the after: date filter is applied
    so only emails since last_sync_at are fetched. For manual syncs (incremental=False),
    no date filter is used — the 2000 most recent IDs are fetched and already-indexed
    ones are skipped via the existing_ids check, filling gaps in the index.
    """
    account_email = account_email.strip()
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            try:
                creds.refresh(GoogleRequest())
                await _persist_refreshed_credentials(db, account_email, creds)
            except Exception as e:
                raise HTTPException(
                    status_code=401,
                    detail=f"Session expired for {account_email} — reconnect at /auth/login. ({e})",
                ) from e
        else:
            raise HTTPException(
                status_code=401,
                detail=f"Session invalid for {account_email} — reconnect at /auth/login.",
            )

    q = ""
    if incremental:
        rows = await _get_gmail_account_rows(db)
        for r in rows:
            if (r.get("email") or "").strip() == account_email:
                q = _gmail_list_query_after_epoch(r.get("last_sync_at"))
                break

    # Load already-indexed IDs upfront so we can skip them per page.
    existing_ids: set[str] = {
        d["id"]
        async for d in db["emails"].find({"accountEmail": account_email}, {"id": 1, "_id": 0})
    }

    def _list_page(page_token: str | None, batch_size: int) -> dict:
        svc = build("gmail", "v1", credentials=creds)
        kwargs: dict = {"userId": "me", "maxResults": batch_size, "q": q}
        if page_token:
            kwargs["pageToken"] = page_token
        return svc.users().messages().list(**kwargs).execute()

    def _fetch_one(msg_id: str) -> dict:
        svc = build("gmail", "v1", credentials=creds)
        raw = svc.users().messages().get(userId="me", id=msg_id, format="full").execute()
        return _raw_message_to_doc(raw, account_email)

    loop = asyncio.get_running_loop()
    # 20 workers for email detail fetches + 1 spare for page listing.
    fetch_tasks: list[asyncio.Future] = []
    collected = 0
    page_token: str | None = None

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=21) as pool:
            # Pipeline: as each page of IDs arrives, immediately fire off
            # email detail fetches for new IDs while the next page is listed.
            while collected < max_results:
                batch_size = min(500, max_results - collected)
                response = await loop.run_in_executor(pool, _list_page, page_token, batch_size)
                page_msgs: list[dict] = response.get("messages", [])
                collected += len(page_msgs)

                # Fire fetch tasks for new IDs on this page without waiting.
                for m in page_msgs:
                    if m["id"] not in existing_ids:
                        fetch_tasks.append(asyncio.ensure_future(
                            loop.run_in_executor(pool, _fetch_one, m["id"])
                        ))

                page_token = response.get("nextPageToken")
                if not page_token or not page_msgs:
                    break

            # Now await all in-flight fetches (most will already be done).
            emails: list[dict] = list(await asyncio.gather(*fetch_tasks))
    except GmailHttpError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Gmail API error ({account_email}): {e.reason}",
        ) from e

    add_embeddings_inplace(emails)
    try:
        for email in emails:
            await db["emails"].update_one({"id": email["id"]}, {"$set": email}, upsert=True)
        await _set_account_last_sync(db, account_email, int(time.time()))
    except PyMongoError as e:
        raise HTTPException(
            status_code=503,
            detail=f"MongoDB unavailable (check MONGODB_URI, network, TLS): {e}",
        ) from e

    return len(emails)


@app.post("/emails/sync")
async def sync_emails():
    """Fetch new emails from Gmail for every connected account and upsert into MongoDB."""
    db = get_db()
    rows = await _get_gmail_account_rows(db)
    if not rows:
        raise HTTPException(
            status_code=401,
            detail="Not authenticated. Visit /auth/login to connect your Gmail account.",
        )

    synced_total = 0
    per_account: dict[str, int] = {}
    last_error: str | None = None
    for row in rows:
        email = (row.get("email") or "").strip()
        if not email:
            continue
        creds = await _credentials_from_row(row)
        if not creds:
            last_error = f"Missing credentials for {email}"
            continue
        try:
            n = await _sync_account_bulk(db, email, creds, max_results=2000)
            synced_total += n
            per_account[email] = n
        except HTTPException as e:
            last_error = str(e.detail)
            logger.warning("Sync failed for %s: %s", email, last_error)

    total = await db["emails"].count_documents({})
    accounts = await _list_connected_emails(db)
    primary = accounts[0] if accounts else None
    if synced_total == 0 and per_account == {} and last_error:
        raise HTTPException(status_code=502, detail=last_error)

    return {
        "synced": synced_total,
        "perAccount": per_account,
        "total": total,
        "gmailAddress": primary,
        "accounts": accounts,
    }


@app.post("/emails/seed")
async def seed_emails():
    """Load mock emails into MongoDB (run once to populate)."""
    import json
    from pathlib import Path

    db = get_db()
    path = Path(__file__).parent / "emails.json"
    emails = json.loads(path.read_text())
    add_embeddings_inplace(emails)
    try:
        await db["emails"].delete_many({})
        await db["emails"].insert_many(emails)
        await db["settings"].delete_one({"_id": SETTINGS_DOC_ID})
        await db["settings"].delete_one({"_id": ACCOUNTS_DOC_ID})
    except PyMongoError as e:
        raise HTTPException(
            status_code=503,
            detail=f"MongoDB unavailable (check MONGODB_URI, network, TLS): {e}",
        ) from e
    return {"inserted": len(emails)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
