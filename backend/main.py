from fastapi import FastAPI, HTTPException
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
from googleapiclient.discovery import build
import base64
from pymongo.errors import PyMongoError

from db import connect_db, close_db, get_db
from embeddings import (
    add_embeddings_inplace,
    cosine_similarity,
    document_search_text,
    embeddings_ready,
    encode,
    warmup,
)
from agent_search import understand_query, rerank

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
CREDENTIALS_FILE = Path(__file__).parent / "credentials.json"  # local dev fallback
TOKEN_FILE = Path(__file__).parent / "token.json"               # local dev fallback

SETTINGS_DOC_ID = "oauth"
TOKEN_DOC_ID = "oauth_token"
LANDING_FILE = Path(__file__).parent / "static" / "index.html"
OAUTH_SUCCESS_FILE = Path(__file__).parent / "static" / "oauth_success.html"
OAUTH_ERROR_FILE = Path(__file__).parent / "static" / "oauth_error.html"


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


def _oauth_error_html(message: str, status_code: int = 400) -> HTMLResponse:
    body = OAUTH_ERROR_FILE.read_text(encoding="utf-8")
    body = body.replace("###ERROR_MESSAGE###", html.escape(message))
    return HTMLResponse(content=body, status_code=status_code)


async def _get_stored_gmail_address(db) -> Optional[str]:
    doc = await db["settings"].find_one({"_id": SETTINGS_DOC_ID})
    if not doc:
        return None
    addr = doc.get("gmail_address")
    return addr.strip() if isinstance(addr, str) and addr.strip() else None


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()
    import asyncio
    asyncio.get_event_loop().run_in_executor(None, warmup)  # fire-and-forget
    yield
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
async def app_status():
    """Returns auth state and email count so the frontend knows what setup step the user is on."""
    db = get_db()
    gmail_auth_email = await _get_stored_gmail_address(db)
    try:
        email_count = await db["emails"].count_documents({})
    except PyMongoError:
        email_count = 0
    return {"gmailAuthEmail": gmail_auth_email, "emailCount": email_count}


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
    auth_url, state = flow.authorization_url(prompt="consent", access_type="offline")
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
    await _save_token(get_db(), flow.credentials)
    return HTMLResponse(
        content=OAUTH_SUCCESS_FILE.read_text(encoding="utf-8"),
        status_code=200,
    )


class QueryRequest(BaseModel):
    query: str
    top_k: int = 5


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    """Multi-turn chat: the server embeds all user lines together for context-aware search."""

    messages: list[ChatMessage]
    top_k: int = 5


def _latest_user_message(messages: list[ChatMessage]) -> str:
    """Return the most recent user message — this is the active search intent."""
    for m in reversed(messages):
        if m.role == "user" and m.content.strip():
            return m.content.strip()
    return ""


async def _semantic_search(query_text: str, top_k: int = 5, history: list[dict] | None = None) -> dict:
    db = get_db()
    try:
        emails = await db["emails"].find({}, {"_id": 0}).to_list(length=1000)
    except PyMongoError as e:
        raise HTTPException(
            status_code=503,
            detail=f"MongoDB unavailable (check MONGODB_URI, network, TLS): {e}",
        ) from e

    gmail_auth_email = await _get_stored_gmail_address(db)
    q = query_text.strip()
    if not q:
        return {"results": [], "gmailAuthEmail": gmail_auth_email}

    if not emails:
        return {"results": [], "gmailAuthEmail": gmail_auth_email}

    try:
        # Use Gemini to understand the query intent (with conversation history for follow-ups)
        intent = understand_query(q, history=history)

        # If Gemini needs clarification, return the question without running a search
        if intent.get("needs_clarification"):
            return {
                "results": [],
                "gmailAuthEmail": gmail_auth_email,
                "intent": intent,
                "clarification": intent.get("clarifying_question"),
            }

        search_q = intent.get("search_query") or q
        keywords = [kw.lower() for kw in intent.get("keywords") or []]
        sender_hint = (intent.get("sender") or "").lower()
        date_hint = intent.get("date_hint")

        candidates = emails

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

        query_vec = encode([search_q])[0]

        if embeddings_ready(candidates):
            email_vecs = np.asarray(
                [e["embedding"] for e in candidates], dtype=np.float32
            )
        else:
            # Legacy docs without ``embedding`` (re-run seed/sync to precompute).
            bodies = [document_search_text(e) for e in candidates]
            email_vecs = encode(bodies)

        scores = cosine_similarity(query_vec, email_vecs)

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
        return {"results": results, "gmailAuthEmail": gmail_auth_email, "intent": intent}
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
    out = await _semantic_search(query_text, req.top_k, history=history)

    if out.get("clarification"):
        out["reply"] = out["clarification"]
    else:
        intent = out.get("intent", {})
        topic = intent.get("topic") or query_text
        n = len(out.get("results", []))
        out["reply"] = f'Found {n} email{"s" if n != 1 else ""} related to: {topic}'
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


@app.post("/emails/sync")
async def sync_emails():
    """Fetch real emails from Gmail and store them in MongoDB."""
    db = get_db()
    creds = await _load_token(db)
    if not creds:
        raise HTTPException(
            status_code=401,
            detail="Not authenticated. Visit /auth/login to connect your Gmail account.",
        )
    service = build("gmail", "v1", credentials=creds)

    profile = service.users().getProfile(userId="me").execute()
    gmail_address = (profile.get("emailAddress") or "").strip()

    # Gmail allows up to 500 IDs per list() call.
    response = service.users().messages().list(userId="me", maxResults=500).execute()
    messages = response.get("messages", [])

    emails = []
    for msg in messages:
        raw = service.users().messages().get(userId="me", id=msg["id"], format="full").execute()
        headers = {h["name"]: h["value"] for h in raw["payload"]["headers"]}

        # Extract plain text body
        body = ""
        payload = raw["payload"]
        if "parts" in payload:
            for part in payload["parts"]:
                if part["mimeType"] == "text/plain":
                    body = base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="ignore")
                    break
        elif "body" in payload and payload["body"].get("data"):
            body = base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="ignore")

        emails.append({
            "id": msg["id"],
            "threadId": raw.get("threadId", ""),
            "subject": headers.get("Subject", "(no subject)"),
            "sender": headers.get("From", ""),
            "date": headers.get("Date", ""),
            "snippet": raw.get("snippet", ""),
            "body": body[:2000],  # cap at 2000 chars for embedding
        })

    add_embeddings_inplace(emails)

    try:
        await db["emails"].delete_many({})
        await db["emails"].insert_many(emails)
        if gmail_address:
            await db["settings"].update_one(
                {"_id": SETTINGS_DOC_ID},
                {"$set": {"gmail_address": gmail_address}},
                upsert=True,
            )
    except PyMongoError as e:
        raise HTTPException(
            status_code=503,
            detail=f"MongoDB unavailable (check MONGODB_URI, network, TLS): {e}",
        ) from e
    return {"synced": len(emails), "gmailAddress": gmail_address}


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
    except PyMongoError as e:
        raise HTTPException(
            status_code=503,
            detail=f"MongoDB unavailable (check MONGODB_URI, network, TLS): {e}",
        ) from e
    return {"inserted": len(emails)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
