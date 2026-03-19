from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from contextlib import asynccontextmanager
import numpy as np
import json
from pathlib import Path
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import base64
import email as email_lib

from db import connect_db, close_db, get_db
from embeddings import encode, cosine_similarity

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
CREDENTIALS_FILE = Path(__file__).parent / "credentials.json"
TOKEN_FILE = Path(__file__).parent / "token.json"


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
    flow = Flow.from_client_secrets_file(
        CREDENTIALS_FILE,
        scopes=SCOPES,
        redirect_uri="http://localhost:8000/auth/callback",
    )
    auth_url, state = flow.authorization_url(prompt="consent", access_type="offline")
    _flows[state] = flow
    return RedirectResponse(auth_url)


@app.get("/auth/callback")
def auth_callback(code: str, state: str):
    """Google redirects here after user grants access. Saves the token."""
    flow = _flows.pop(state, None)
    if not flow:
        return {"error": "Invalid or expired state. Try /auth/login again."}
    flow.fetch_token(code=code)
    TOKEN_FILE.write_text(flow.credentials.to_json())
    return {"status": "authenticated", "message": "You can close this tab."}


class QueryRequest(BaseModel):
    query: str
    top_k: int = 5


@app.post("/ask")
async def ask(req: QueryRequest):
    db = get_db()
    emails = await db["emails"].find({}, {"_id": 0}).to_list(length=1000)

    if not emails:
        return {"results": []}

    bodies = [f"{e['subject']} {e['body']}" for e in emails]
    email_vecs = encode(bodies)
    query_vec = encode([req.query])[0]

    scores = cosine_similarity(query_vec, email_vecs)
    top_indices = np.argsort(scores)[::-1][: req.top_k]

    results = [
        {**emails[i], "score": round(float(scores[i]), 4)}
        for i in top_indices
    ]
    return {"results": results}


@app.post("/emails/sync")
async def sync_emails():
    """Fetch real emails from Gmail and store them in MongoDB."""
    if not TOKEN_FILE.exists():
        return {"error": "Not authenticated. Visit http://localhost:8000/auth/login first."}

    creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    service = build("gmail", "v1", credentials=creds)

    # Fetch latest 100 message IDs
    response = service.users().messages().list(userId="me", maxResults=100).execute()
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
            "subject": headers.get("Subject", "(no subject)"),
            "sender": headers.get("From", ""),
            "date": headers.get("Date", ""),
            "snippet": raw.get("snippet", ""),
            "body": body[:2000],  # cap at 2000 chars for embedding
        })

    db = get_db()
    await db["emails"].delete_many({})
    await db["emails"].insert_many(emails)
    return {"synced": len(emails)}


@app.post("/emails/seed")
async def seed_emails():
    """Load mock emails into MongoDB (run once to populate)."""
    import json
    from pathlib import Path

    db = get_db()
    path = Path(__file__).parent / "emails.json"
    emails = json.loads(path.read_text())
    await db["emails"].delete_many({})
    await db["emails"].insert_many(emails)
    return {"inserted": len(emails)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
