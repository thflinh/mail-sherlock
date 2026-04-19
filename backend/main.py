from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager
from typing import Literal, Optional
import html
import json
import numpy as np
import os
import uuid
from pathlib import Path
import secrets
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError as GmailHttpError
import asyncio
import base64
import concurrent.futures
import hashlib
import logging
import secrets
import time
import threading
from datetime import datetime, timedelta, timezone
from pymongo import UpdateOne
from pymongo.errors import PyMongoError
from rank_bm25 import BM25Okapi

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
from agent_search import understand_query, rerank
from agent import find as agent_find, answer as agent_answer, summarize as agent_summarize, extract as agent_extract, chitchat as agent_chitchat
from reader import get_email_for_reader
from labels import assign_labels_bulk
from chunk_index import ensure_chunk_indexes, merged_chunk_body_for_query, rebuild_chunks_for_emails
from passage_select import body_for_llm, log_rag_passage_context

logger = logging.getLogger(__name__)

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


async def _load_token(db, session_id: str) -> Optional[Credentials]:
    """Load OAuth token from MongoDB, falling back to local token.json for dev."""
    doc = await db["settings"].find_one({"_id": _token_doc_id(session_id)})
    if doc and doc.get("token_json"):
        return Credentials.from_authorized_user_info(json.loads(doc["token_json"]), SCOPES)
    if TOKEN_FILE.exists():
        return Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    return None


async def _save_token(db, session_id: str, creds: Credentials) -> None:
    """Persist OAuth token to MongoDB so it survives server restarts."""
    await db["settings"].update_one(
        {"_id": _token_doc_id(session_id)},
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

        def _fetch_raw(msg_id: str) -> dict:
            svc = build("gmail", "v1", credentials=creds)
            raw = svc.users().messages().get(userId="me", id=msg_id, format="full").execute()
            return _raw_message_to_doc(raw, account_email)

        loop = asyncio.get_running_loop()
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            futures = [
                asyncio.ensure_future(loop.run_in_executor(pool, _fetch_raw, m["id"]))
                for m in messages
            ]
            emails: list[dict] = list(await asyncio.gather(*futures))

        add_embeddings_inplace(emails)
        assign_labels_bulk(emails)

        if emails:
            ops = [UpdateOne({"id": e["id"]}, {"$set": e}, upsert=True) for e in emails]
            await db["emails"].bulk_write(ops, ordered=False)
            await rebuild_chunks_for_emails(db, emails)

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
    await ensure_chunk_indexes(get_db())
    asyncio.get_event_loop().run_in_executor(None, warmup)  # warm up embedding model
    task = asyncio.create_task(_background_sync_loop())
    yield
    task.cancel()
    await close_db()


app = FastAPI(title="mail-sherlock", lifespan=lifespan)

_extra_origins = [
    x.strip()
    for x in os.getenv("CORS_ALLOW_ORIGINS", "").split(",")
    if x.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_STATIC_DIR = Path(__file__).parent / "static"
if (_STATIC_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(_STATIC_DIR / "assets")), name="assets")


_flows = {}


class EmailSignupRequest(BaseModel):
    name: str
    email: str
    password: str


class EmailLoginRequest(BaseModel):
    email: str
    password: str


def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def _new_session_token() -> str:
    return secrets.token_urlsafe(32)


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


@app.post("/auth/logout")
async def auth_logout():
    """Remove all stored OAuth tokens and accounts so the user is fully signed out.

    Clears:
      - MongoDB settings.gmail_accounts (all account rows)
      - MongoDB settings.oauth_token    (legacy single-token doc)
      - MongoDB settings.active_account
      - backend/token.json              (local dev fallback)
    Does NOT delete indexed emails — those stay cached for a potential re-connect.
    """
    db = get_db()
    await db["settings"].delete_one({"_id": ACCOUNTS_DOC_ID})
    await db["settings"].delete_one({"_id": TOKEN_DOC_ID})
    await db["settings"].delete_one({"_id": "active_account"})
    if TOKEN_FILE.exists():
        try:
            TOKEN_FILE.unlink()
        except OSError:
            pass
    return {"ok": True}


@app.post("/auth/signup")
async def auth_signup(payload: EmailSignupRequest):
    db = get_db()
    name = payload.name.strip()
    email = payload.email.strip().lower()
    password = payload.password
    if not name:
        raise HTTPException(status_code=400, detail="Name is required.")
    if not email:
        raise HTTPException(status_code=400, detail="Email is required.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")

    existing = await db["users_auth"].find_one({"email": email})
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered.")

    user_id = str(uuid.uuid4())
    await db["users_auth"].insert_one(
        {
            "_id": user_id,
            "name": name,
            "email": email,
            "password_hash": _hash_password(password),
            "created_at": datetime.utcnow().isoformat(),
        }
    )
    token = _new_session_token()
    await db["auth_sessions"].insert_one(
        {
            "_id": token,
            "user_id": user_id,
            "email": email,
            "created_at": datetime.utcnow().isoformat(),
        }
    )
    return {
        "ok": True,
        "token": token,
        "user": {"id": user_id, "name": name, "email": email},
    }


@app.post("/auth/login/email")
async def auth_login_email(payload: EmailLoginRequest):
    db = get_db()
    email = payload.email.strip().lower()
    password = payload.password
    if not email or not password:
        raise HTTPException(status_code=400, detail="Email and password are required.")

    user = await db["users_auth"].find_one({"email": email})
    if not user or user.get("password_hash") != _hash_password(password):
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    token = _new_session_token()
    await db["auth_sessions"].insert_one(
        {
            "_id": token,
            "user_id": user["_id"],
            "email": email,
            "created_at": datetime.utcnow().isoformat(),
        }
    )
    return {
        "ok": True,
        "token": token,
        "user": {"id": user["_id"], "name": user.get("name", ""), "email": email},
    }


@app.get("/auth/session")
async def auth_session(token: Optional[str] = None):
    if not token:
        return {"authenticated": False}
    db = get_db()
    sess = await db["auth_sessions"].find_one({"_id": token})
    if not sess:
        return {"authenticated": False}
    user = await db["users_auth"].find_one({"_id": sess.get("user_id")}) if sess.get("user_id") else None
    return {
        "authenticated": True,
        "user": {
            "id": sess.get("user_id"),
            "email": sess.get("email"),
            "name": (user or {}).get("name", ""),
        },
    }


@app.post("/auth/session/logout")
async def auth_session_logout(body: dict):
    token = (body.get("token") or "").strip()
    if not token:
        return {"ok": True}
    db = get_db()
    await db["auth_sessions"].delete_one({"_id": token})
    return {"ok": True}


@app.get("/auth/login")
def auth_login(request: Request):
    """Redirects the user to Google's OAuth consent screen."""
    try:
        config = _load_credentials_config()
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    session_id = _session_id_from_request(request) or _new_session_id()
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
async def auth_callback(
    request: Request,
    code: Optional[str] = None,
    state: Optional[str] = None,
):
    """Google redirects here with ?code=...&state=... after the user grants access."""
    if not code or not state:
        return _oauth_error_html(
            "This page only works when Google redirects here after you approve access. "
            'Open http://localhost:8000/ and click "Authorize Gmail", or go to /auth/login.',
        )
    saved = _flows.pop(state, None)
    if not saved:
        return _oauth_error_html(
            "The sign-in session expired (for example the API restarted). "
            "Go to http://localhost:8000/auth/login and try again.",
        )
    flow = saved["flow"]
    flow_session_id = saved["session_id"]
    cookie_session_id = _session_id_from_request(request)
    if not cookie_session_id or cookie_session_id != flow_session_id:
        return _oauth_error_html(
            "Session mismatch. This sign-in link belongs to a different browser session. "
            "Go to /auth/login and try again.",
            status_code=401,
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
    last_30_days: bool = False
    account_email: Optional[str] = None


class ConversationContext(BaseModel):
    """Client-owned snapshot of which search results a follow-up refers to."""

    result_ids: list[str] = Field(default_factory=list)
    active_email_id: Optional[str] = None
    mode: str = "find"
    search_key: Optional[str] = None


class ChatRequest(BaseModel):
    """Multi-turn chat with mode-routing through the Gemini agent."""

    messages: list[ChatMessage]
    top_k: int = 5
    filters: Optional[FilterOptions] = None
    active_email_id: Optional[str] = None
    context: Optional[ConversationContext] = None


def _conversation_search_key(top_k: int, filters: dict | None) -> str:
    f = filters or {}
    payload = json.dumps(
        {"top_k": top_k, "filters": {k: f[k] for k in sorted(f.keys())}},
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


_VALID_CONTEXT_REFS = frozenset({"first", "second", "third", "last", "active"})


def _normalize_context_ref(raw) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if not s or s == "null":
        return None
    if s in _VALID_CONTEXT_REFS:
        return s
    return None


def _resolve_context_ref_to_email_id(ctx: ConversationContext, ref: Optional[str]) -> Optional[str]:
    ids = [str(x) for x in ctx.result_ids if x]
    if not ids:
        return None
    if ref is None:
        aid = (ctx.active_email_id or "").strip()
        if aid and aid in ids:
            return aid
        return ids[0]
    if ref == "first":
        return ids[0]
    if ref == "second":
        return ids[1] if len(ids) > 1 else ids[0]
    if ref == "third":
        return ids[2] if len(ids) > 2 else ids[-1]
    if ref == "last":
        return ids[-1]
    if ref == "active":
        aid = (ctx.active_email_id or "").strip()
        return aid if aid and aid in ids else ids[0]
    return ids[0]


def _context_matches_request(ctx: ConversationContext, top_k: int, filters: dict | None) -> bool:
    if not ctx.search_key:
        return False
    return ctx.search_key == _conversation_search_key(top_k, filters)


def _build_chat_context_dict(
    mode: str,
    results: list[dict],
    active_email_id: Optional[str],
    top_k: int,
    filters: dict | None,
) -> dict:
    ids: list[str] = []
    for r in results:
        eid = r.get("id")
        if eid and str(eid) not in ids:
            ids.append(str(eid))
    key = _conversation_search_key(top_k, filters)
    active = (active_email_id or "").strip() or None
    if active and active not in ids and ids:
        active = ids[0]
    elif not active and ids:
        active = ids[0]
    return {
        "result_ids": ids,
        "active_email_id": active,
        "mode": mode,
        "search_key": key,
    }


def _strip_email_for_api(doc: dict, score: float = 0.0) -> dict:
    row = {
        k: v
        for k, v in doc.items()
        if k not in ("embedding", "emb_subject", "emb_body", "owner_session", "_id")
    }
    row["score"] = score
    return row


async def _fetch_email_doc(db, session_id: str, email_id: str) -> Optional[dict]:
    doc = await db["emails"].find_one(
        {"id": email_id, "owner_session": session_id},
        {"_id": 0, "embedding": 0, "emb_subject": 0, "emb_body": 0, "owner_session": 0},
    )
    return doc


async def _fetch_emails_by_ids_ordered(
    db, session_id: str, ids: list[str], *, score: float = 0.0
) -> list[dict]:
    out: list[dict] = []
    for eid in ids:
        if not eid:
            continue
        doc = await _fetch_email_doc(db, session_id, str(eid))
        if doc:
            out.append(_strip_email_for_api(doc, score=score))
    return out


class EventCreate(BaseModel):
    title: str
    date: str
    time: Optional[str] = None
    description: Optional[str] = None
    source_email_id: Optional[str] = None


@app.post("/events")
async def create_event(event: EventCreate):
    db = get_db()
    doc = {
        "_id": str(uuid.uuid4()),
        "title": event.title.strip(),
        "date": event.date,
        "time": event.time,
        "description": event.description,
        "source": "manual" if not event.source_email_id else "from_email",
        "source_email_id": event.source_email_id,
        "created_at": datetime.utcnow().isoformat(),
    }
    await db["events"].insert_one(doc)
    out = dict(doc)
    out["id"] = out.pop("_id")
    return {"ok": True, "event": out}


@app.get("/events")
async def get_events():
    db = get_db()
    rows = await db["events"].find(
        {},
        {
            "_id": 1,
            "title": 1,
            "date": 1,
            "time": 1,
            "description": 1,
            "source": 1,
            "source_email_id": 1,
            "created_at": 1,
        },
    ).to_list(length=1000)
    events = []
    for e in rows:
        e["id"] = e.pop("_id")
        events.append(e)
    events.sort(key=lambda e: ((e.get("date") or ""), (e.get("time") or ""), (e.get("title") or "")))
    return {"events": events}


@app.delete("/events/{event_id}")
async def delete_event(event_id: str):
    db = get_db()
    await db["events"].delete_one({"_id": event_id})
    return {"ok": True}


def _latest_user_message(messages: list[ChatMessage]) -> str:
    """Return the most recent user message — this is the active search intent."""
    for m in reversed(messages):
        if m.role == "user" and m.content.strip():
            return m.content.strip()
    return ""


async def _semantic_search(
    query_text: str,
    session_id: str,
    top_k: int = 5,
    history: list[dict] | None = None,
    filters: dict | None = None,
    intent: dict | None = None,
) -> dict:
    db = get_db()
    try:
        emails = await db["emails"].find(
            {"owner_session": session_id},
            {"_id": 0, "owner_session": 0},
        ).to_list(length=1000)
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
        if intent is None:
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

        results = rerank(search_q, pre_results, top_k=top_k)
        if logger.isEnabledFor(logging.DEBUG) and results:
            tops = [round(float(x.get("score", 0)), 4) for x in results[:5]]
            logger.debug("semantic_search pre_k=%s top_scores=%s", pre_k, tops)
        return {
            "results": results,
            "gmailAuthEmail": gmail_auth_email,
            "accounts": connected_accounts,
            "intent": intent,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {e}") from e


async def _augment_email_body_for_llm(
    db,
    email_doc: dict,
    passage_query: str,
) -> tuple[dict, dict, dict]:
    """Prefer persisted chunk embeddings; else sliding-window passage selection."""
    raw = email_doc.get("body") or email_doc.get("snippet") or ""
    chunk_text, cmeta = await merged_chunk_body_for_query(db, email_doc, passage_query)
    if chunk_text:
        pmeta = {
            "raw_body_len": len(raw),
            "sent_len": len(chunk_text),
            "truncated_vs_raw": len(chunk_text) < len(raw),
            "strategy": "chunk_embeddings",
        }
        return {**email_doc, "body": chunk_text}, pmeta, cmeta
    body, pmeta = body_for_llm(raw, passage_query)
    return {**email_doc, "body": body}, pmeta, cmeta


@app.post("/ask")
async def ask(req: QueryRequest, request: Request):
    session_id = _require_session_id(request)
    return await _semantic_search(req.query, session_id, top_k=req.top_k)


@app.post("/chat")
async def chat(req: ChatRequest, request: Request):
    session_id = _require_session_id(request)
    query_text = _latest_user_message(req.messages)
    if not query_text:
        raise HTTPException(status_code=400, detail="Add at least one user message with text.")

    history = [{"role": m.role, "content": m.content} for m in req.messages[:-1]]
    filters = req.filters.model_dump() if req.filters else None
    prior_ok = req.context is not None and _context_matches_request(
        req.context, req.top_k, filters
    )

    db = get_db()
    gmail_auth_email = await _get_stored_gmail_address(db)
    connected_accounts = await _list_connected_emails(db)

    intent = understand_query(query_text, history=history)

    if intent.get("needs_clarification"):
        ctx_out = req.context.model_dump() if prior_ok else None
        return {
            "reply": intent.get("clarifying_question", "Could you give me more details?"),
            "mode": "clarify",
            "results": [],
            "intent": intent,
            "clarification": intent.get("clarifying_question"),
            "gmailAuthEmail": gmail_auth_email,
            "accounts": connected_accounts,
            "context": ctx_out,
        }

    mode = intent.get("mode") or "find"
    uses_prior = bool(intent.get("uses_prior_context"))
    context_ref = _normalize_context_ref(intent.get("context_ref"))

    if mode == "chitchat":
        resp = agent_chitchat(query_text, conversation=history)
        ctx_out = req.context.model_dump() if prior_ok else None
        return {
            "reply": resp.reply,
            "mode": resp.mode,
            "results": [],
            "intent": intent,
            "gmailAuthEmail": gmail_auth_email,
            "accounts": connected_accounts,
            "clarification": None,
            "context": ctx_out,
        }

    candidates: list[dict] = []
    preloaded_email: Optional[dict] = None

    if mode in ("find", "summarize"):
        search_result = await _semantic_search(
            query_text,
            session_id,
            req.top_k,
            history=history,
            filters=filters,
            intent=intent,
        )
        candidates = list(search_result.get("results") or [])
        gmail_auth_email = search_result.get("gmailAuthEmail", gmail_auth_email)
        connected_accounts = list(search_result.get("accounts") or connected_accounts)

    elif mode in ("answer", "extract"):
        prior_path = bool(uses_prior and prior_ok and req.context is not None)
        if prior_path:
            tid = (req.active_email_id or "").strip() or None
            if not tid:
                tid = _resolve_context_ref_to_email_id(req.context, context_ref)
            if tid:
                preloaded_email = await _fetch_email_doc(db, session_id, tid)
            id_slice = list(req.context.result_ids)[: req.top_k]
            candidates = await _fetch_emails_by_ids_ordered(db, session_id, id_slice, score=0.0)
            if not preloaded_email:
                prior_path = False
        if not prior_path:
            search_result = await _semantic_search(
                query_text,
                session_id,
                req.top_k,
                history=history,
                filters=filters,
                intent=intent,
            )
            candidates = list(search_result.get("results") or [])
            gmail_auth_email = search_result.get("gmailAuthEmail", gmail_auth_email)
            connected_accounts = list(search_result.get("accounts") or connected_accounts)
            preloaded_email = None
    else:
        search_result = await _semantic_search(
            query_text,
            session_id,
            req.top_k,
            history=history,
            filters=filters,
            intent=intent,
        )
        candidates = list(search_result.get("results") or [])
        gmail_auth_email = search_result.get("gmailAuthEmail", gmail_auth_email)
        connected_accounts = list(search_result.get("accounts") or connected_accounts)

    if mode == "answer":
        email_doc = None
        if (req.active_email_id or "").strip():
            email_doc = await _fetch_email_doc(db, session_id, req.active_email_id.strip())
        if not email_doc and preloaded_email:
            email_doc = preloaded_email
        if not email_doc and candidates:
            top_id = candidates[0].get("id")
            if top_id:
                email_doc = await _fetch_email_doc(db, session_id, str(top_id))
            if not email_doc:
                email_doc = candidates[0]
        if not email_doc:
            return {
                "reply": "I couldn't find a relevant email to answer that question from.",
                "mode": mode,
                "results": [],
                "intent": intent,
                "gmailAuthEmail": gmail_auth_email,
                "accounts": connected_accounts,
                "clarification": None,
                "context": _build_chat_context_dict(mode, [], None, req.top_k, filters),
            }
        top_score = float(candidates[0].get("score", 0)) if candidates else None
        email_llm, pmeta, cmeta = await _augment_email_body_for_llm(db, email_doc, query_text)
        log_rag_passage_context(
            "answer",
            str(email_doc.get("id")),
            pmeta,
            top_retrieval_score=top_score,
            chunk_meta=cmeta,
        )
        resp = agent_answer(query_text, email_llm, conversation=history)
        active_id = email_doc.get("id")
        if uses_prior and prior_ok and req.context is not None:
            ctx_dict = {
                "result_ids": list(req.context.result_ids),
                "active_email_id": active_id,
                "mode": "answer",
                "search_key": _conversation_search_key(req.top_k, filters),
            }
        else:
            ctx_dict = _build_chat_context_dict("answer", candidates, active_id, req.top_k, filters)

    elif mode == "summarize":
        emails_to_summarize = candidates[:5]
        if (req.active_email_id or "").strip() and not emails_to_summarize:
            doc = await _fetch_email_doc(db, session_id, req.active_email_id.strip())
            if doc:
                emails_to_summarize = [doc]
        max_raw = (
            max(len(e.get("body") or "") for e in emails_to_summarize)
            if emails_to_summarize
            else 0
        )
        logger.info(
            "rag_context mode=summarize email_count=%s max_raw_body_len=%s",
            len(emails_to_summarize),
            max_raw,
        )
        resp = agent_summarize(emails_to_summarize, query_text)
        active_id = resp.results[0].get("id") if resp.results else None
        ctx_dict = _build_chat_context_dict("summarize", candidates, active_id, req.top_k, filters)

    elif mode == "extract":
        extract_field = intent.get("extract_field") or "information"
        email_doc = None
        if (req.active_email_id or "").strip():
            email_doc = await _fetch_email_doc(db, session_id, req.active_email_id.strip())
        if not email_doc and preloaded_email:
            email_doc = preloaded_email
        if not email_doc and candidates:
            top_id = candidates[0].get("id")
            if top_id:
                email_doc = await _fetch_email_doc(db, session_id, str(top_id))
            if not email_doc:
                email_doc = candidates[0]
        if not email_doc:
            return {
                "reply": "I couldn't find a relevant email to extract from.",
                "mode": mode,
                "results": [],
                "intent": intent,
                "gmailAuthEmail": gmail_auth_email,
                "accounts": connected_accounts,
                "clarification": None,
                "context": _build_chat_context_dict(mode, [], None, req.top_k, filters),
            }
        passage_q = f"{extract_field} {query_text}"
        top_score = float(candidates[0].get("score", 0)) if candidates else None
        email_llm, pmeta, cmeta = await _augment_email_body_for_llm(db, email_doc, passage_q)
        log_rag_passage_context(
            "extract",
            str(email_doc.get("id")),
            pmeta,
            top_retrieval_score=top_score,
            chunk_meta=cmeta,
        )
        resp = agent_extract(extract_field, email_llm)
        active_id = email_doc.get("id")
        if uses_prior and prior_ok and req.context is not None:
            ctx_dict = {
                "result_ids": list(req.context.result_ids),
                "active_email_id": active_id,
                "mode": "extract",
                "search_key": _conversation_search_key(req.top_k, filters),
            }
        else:
            ctx_dict = _build_chat_context_dict("extract", candidates, active_id, req.top_k, filters)

    else:
        resp = agent_find(query_text, candidates, conversation=history)
        first_id = resp.results[0].get("id") if resp.results else None
        ctx_dict = _build_chat_context_dict("find", resp.results, first_id, req.top_k, filters)

    return {
        "reply": resp.reply,
        "mode": resp.mode,
        "results": resp.results,
        "intent": intent,
        "gmailAuthEmail": gmail_auth_email,
        "accounts": connected_accounts,
        "clarification": None,
        "context": ctx_dict,
    }


@app.get("/email/{email_id}")
async def get_email(email_id: str):
    """Fetch full email content for the in-app reading panel."""
    db = get_db()
    doc = await get_email_for_reader(email_id, db)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Email {email_id} not found.")
    return doc


@app.get("/accounts")
async def get_accounts():
    """Return all connected accounts with status, email count, and last-synced time."""
    db = get_db()
    rows = await _get_gmail_account_rows(db)

    # Determine the active account (explicitly set or first in list)
    active_doc = await db["settings"].find_one({"_id": "active_account"})
    active_email = (active_doc.get("active") or "").strip() if active_doc else ""
    if not active_email and rows:
        active_email = (rows[0].get("email") or "").strip()

    accounts_out = []
    for row in rows:
        email = (row.get("email") or "").strip()
        if not email:
            continue
        try:
            email_count = await db["emails"].count_documents({"accountEmail": email})
        except PyMongoError:
            email_count = 0
        last_synced = row.get("last_sync_at")  # Unix timestamp or None
        status = "active" if email == active_email else "cached"
        accounts_out.append({
            "email": email,
            "status": status,
            "emailCount": email_count,
            "lastSynced": last_synced,
        })

    return {"active": active_email or None, "accounts": accounts_out}


@app.post("/accounts/switch")
async def switch_account(body: dict):
    """Switch the active account to a connected one."""
    email = (body.get("email") or "").strip()
    if not email:
        raise HTTPException(status_code=400, detail="email required")

    db = get_db()
    rows = await _get_gmail_account_rows(db)
    connected = [(r.get("email") or "").strip() for r in rows]
    if email not in connected:
        raise HTTPException(status_code=404, detail=f"Account {email} not connected")

    await db["settings"].update_one(
        {"_id": "active_account"},
        {"$set": {"active": email}},
        upsert=True,
    )

    try:
        email_count = await db["emails"].count_documents({"accountEmail": email})
    except PyMongoError:
        email_count = 0

    return {"active": email, "emailCount": email_count, "status": "active"}


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

    # Each worker thread gets its own service instance (googleapiclient is not
    # thread-safe for shared use), but we avoid the discovery-document HTTP fetch
    # on every call by reusing the instance within the same thread.
    _tls = threading.local()

    def _get_svc():
        if not hasattr(_tls, "svc"):
            _tls.svc = build("gmail", "v1", credentials=creds)
        return _tls.svc

    def _list_page(page_token: str | None, batch_size: int) -> dict:
        kwargs: dict = {"userId": "me", "maxResults": batch_size, "q": q}
        if page_token:
            kwargs["pageToken"] = page_token
        return _get_svc().users().messages().list(**kwargs).execute()

    def _fetch_one(msg_id: str) -> dict:
        raw = _get_svc().users().messages().get(userId="me", id=msg_id, format="full").execute()
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
    assign_labels_bulk(emails)
    try:
        if emails:
            ops = [UpdateOne({"id": e["id"]}, {"$set": e}, upsert=True) for e in emails]
            await db["emails"].bulk_write(ops, ordered=False)
            await rebuild_chunks_for_emails(db, emails)
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

    # Build task list — one coroutine per valid account.
    account_emails: list[str] = []
    tasks = []
    last_error: str | None = None
    for row in rows:
        email = (row.get("email") or "").strip()
        if not email:
            continue
        creds = await _credentials_from_row(row)
        if not creds:
            last_error = f"Missing credentials for {email}"
            continue
        account_emails.append(email)
        tasks.append(_sync_account_bulk(db, email, creds, max_results=1000))

    # Run all account syncs concurrently instead of sequentially.
    results = await asyncio.gather(*tasks, return_exceptions=True)

    synced_total = 0
    per_account: dict[str, int] = {}
    for email, result in zip(account_emails, results):
        if isinstance(result, Exception):
            last_error = str(result.detail) if isinstance(result, HTTPException) else str(result)
            logger.warning("Sync failed for %s: %s", email, last_error)
        else:
            synced_total += result
            per_account[email] = result

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
async def seed_emails(request: Request):
    """Load mock emails into MongoDB (run once to populate)."""
    db = get_db()
    session_id = _require_session_id(request)
    path = Path(__file__).parent / "emails.json"
    emails = json.loads(path.read_text())
    for e in emails:
        e["owner_session"] = session_id
    add_embeddings_inplace(emails)
    assign_labels_bulk(emails)
    try:
        await db["email_chunks"].delete_many({"ingest_key": session_id})
        await db["emails"].delete_many({"owner_session": session_id})
        await db["emails"].insert_many(emails)
        await rebuild_chunks_for_emails(db, emails)
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
