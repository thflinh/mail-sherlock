from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from contextlib import asynccontextmanager
from typing import Optional
import numpy as np
import json
from pathlib import Path
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import base64
import email as email_lib
from pymongo.errors import PyMongoError

from db import connect_db, close_db, get_db
from embeddings import (
    add_embeddings_inplace,
    cosine_similarity,
    document_search_text,
    embeddings_ready,
    encode,
)

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
CREDENTIALS_FILE = Path(__file__).parent / "credentials.json"
TOKEN_FILE = Path(__file__).parent / "token.json"

SETTINGS_DOC_ID = "oauth"


async def _get_stored_gmail_address(db) -> Optional[str]:
    doc = await db["settings"].find_one({"_id": SETTINGS_DOC_ID})
    if not doc:
        return None
    addr = doc.get("gmail_address")
    return addr.strip() if isinstance(addr, str) and addr.strip() else None


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()
    yield
    await close_db()


app = FastAPI(title="mail-sherlock", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


_flows = {}


@app.get("/auth/login")
def auth_login():
    """Redirects the user to Google's OAuth consent screen."""
    if not CREDENTIALS_FILE.exists():
        raise HTTPException(
            status_code=500,
            detail=f"Missing {CREDENTIALS_FILE.name}. Add the OAuth client JSON from Google Cloud Console (see README).",
        )
    flow = Flow.from_client_secrets_file(
        CREDENTIALS_FILE,
        scopes=SCOPES,
        redirect_uri="http://localhost:8000/auth/callback",
    )
    auth_url, state = flow.authorization_url(prompt="consent", access_type="offline")
    _flows[state] = flow
    return RedirectResponse(auth_url)


@app.get("/auth/callback")
def auth_callback(code: Optional[str] = None, state: Optional[str] = None):
    """Google redirects here with ?code=...&state=... after the user grants access."""
    if not code or not state:
        raise HTTPException(
            status_code=400,
            detail=(
                "You opened /auth/callback without a Google redirect. "
                "Start here instead: http://localhost:8000/auth/login — "
                "after you approve access, Google will send you back with ?code= and ?state= automatically."
            ),
        )
    flow = _flows.pop(state, None)
    if not flow:
        raise HTTPException(
            status_code=400,
            detail="Invalid or expired OAuth state (server restarted?). Open http://localhost:8000/auth/login again.",
        )
    try:
        flow.fetch_token(code=code)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Could not complete sign-in: {e}",
        ) from e
    TOKEN_FILE.write_text(flow.credentials.to_json())
    return {"status": "authenticated", "message": "You can close this tab."}


class QueryRequest(BaseModel):
    query: str
    top_k: int = 5


@app.post("/ask")
async def ask(req: QueryRequest):
    db = get_db()
    try:
        emails = await db["emails"].find({}, {"_id": 0}).to_list(length=1000)
    except PyMongoError as e:
        raise HTTPException(
            status_code=503,
            detail=f"MongoDB unavailable (check MONGODB_URI, network, TLS): {e}",
        ) from e

    gmail_auth_email = await _get_stored_gmail_address(db)

    if not emails:
        return {"results": [], "gmailAuthEmail": gmail_auth_email}

    try:
        query_vec = encode([req.query])[0]

        if embeddings_ready(emails):
            email_vecs = np.asarray(
                [e["embedding"] for e in emails], dtype=np.float32
            )
        else:
            # Legacy docs without ``embedding`` (re-run seed/sync to precompute).
            bodies = [document_search_text(e) for e in emails]
            email_vecs = encode(bodies)

        scores = cosine_similarity(query_vec, email_vecs)
        top_indices = np.argsort(scores)[::-1][: req.top_k]

        results = []
        for i in top_indices:
            row = {k: v for k, v in emails[i].items() if k != "embedding"}
            row["score"] = round(float(scores[i]), 4)
            results.append(row)
        return {"results": results, "gmailAuthEmail": gmail_auth_email}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {e}") from e


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
    if not TOKEN_FILE.exists():
        raise HTTPException(
            status_code=401,
            detail="Not authenticated. Open http://127.0.0.1:8000/auth/login in a browser, finish Google sign-in, then POST /emails/sync again.",
        )

    creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
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

    db = get_db()
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
