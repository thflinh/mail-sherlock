# mail-sherlock

Semantic search over email: a **FastAPI** backend (embeddings + MongoDB) and a **Chrome extension** popup that calls `http://localhost:8000`.

## Prerequisites

- **Python 3.10+** (3.11 recommended)
- **Node.js 18+** and npm
- **MongoDB** reachable from your machine ([MongoDB Atlas](https://www.mongodb.com/atlas) or local)
- **Google Chrome** (for the extension)

## 1. Backend

From the repo root (or any path; adjust `cd`):

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

**Environment:** create `backend/.env` (optional keys):

```env
MONGODB_URI=mongodb+srv://USER:PASS@cluster.example.mongodb.net/?appName=your-app
DB_MAIL=mail_sherlock
```

**Local MongoDB (recommended when Atlas TLS fails on your PC):** from the **repo root** (with [Docker Desktop](https://www.docker.com/products/docker-desktop/) running):

```bash
docker compose up -d
```

Then in `backend/.env` use `MONGODB_URI=mongodb://127.0.0.1:27017` (the repo’s `.env` is set up this way by default for dev).

If `docker compose` errors about `dockerDesktopLinuxEngine`, start **Docker Desktop** and wait until it is fully up, then run `docker compose up -d` again.

If `MONGODB_URI` is missing, the app falls back to a default in code—prefer setting your own URI and **do not commit secrets**.

**Gmail (optional):** put the Google OAuth client JSON in `backend/credentials.json` (see **Real Gmail** below).

**Start the API:**

```bash
python main.py
```

Or: `uvicorn main:app --reload --host 0.0.0.0 --port 8000`

API base: **http://localhost:8000**

**Populate email data** (pick one):

| Method | How |
|--------|-----|
| Mock data | `POST .../emails/seed` |
| Real Gmail | Browser OAuth, then `POST .../emails/sync` (steps below) |

### Real Gmail (fetch your inbox into MongoDB)

1. **Google Cloud Console** → APIs & Services → Credentials → Create **OAuth client ID** → type **Web application**.  
2. Under **Authorized redirect URIs**, add exactly: `http://localhost:8000/auth/callback`  
3. Download the client JSON → save as **`backend/credentials.json`**.  
4. **Enable the Gmail API** for that Google Cloud project (APIs & Library → Gmail API → Enable).  
5. Start the backend on port **8000** (`python main.py` or `uvicorn ...`).  
6. In a browser, open **`http://localhost:8000/auth/login`** (use `localhost`, not `127.0.0.1`, so it matches Google’s redirect URI). Sign in and allow access. You should see JSON like `{"status":"authenticated",...}` and `backend/token.json` will appear.  
7. **Do not** restart the server between clicking “login” and finishing Google’s page if you use `--reload` in dev—the in-memory OAuth `state` can be lost on reload.  
8. Pull messages into MongoDB (PowerShell):

   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:8000/emails/sync" -Method POST
   ```

   Expect `synced` with a number (up to **500** latest messages per sync). Search then uses **your** mail; extension **Open in Gmail** links work when `threadId` is stored.

If sync returns **401**, do step 6 again. If **login** returns **500** about missing credentials, add `credentials.json`. If Google shows **redirect_uri_mismatch**, fix the URI in Cloud Console to match step 2 exactly.

First run downloads the sentence-transformer model (~90MB+); startup can take a minute.

**Search speed:** Each email’s embedding is computed **once** when you **`POST /emails/seed`** or **`POST /emails/sync`** and stored in MongoDB. **`POST /ask`** then only encodes your query, so search is much faster than re-encoding every message each time. Re-run seed/sync after upgrading this logic so stored docs include `embedding`.

## 2. Chrome extension

```bash
cd extension
npm install
npm run build
```

This writes the unpacked extension to **`dist/`** at the repo root (see `vite.config.ts`).

**Load in Chrome:**

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → choose the **`dist`** folder inside this repo (`mail-sherlock/dist`)

The popup talks to the backend at **`http://127.0.0.1:8000`** (see `src/api/search.ts`). Keep the Python server running while you use the extension. After changing API URLs or `manifest.json`, run **`npm run build`** again and click **Reload** on the extension in `chrome://extensions`.

## 3. Use it

1. Backend running on port **8000**
2. Extension loaded from **`dist`**
3. Click the extension icon, type a natural-language query, **Search**

After **Gmail sync**, search responses include **`gmailAuthEmail`** (the address that completed OAuth). **Open in Gmail** uses Google’s `authuser=` with that address so the correct account opens—not Chrome’s default `/u/0` slot. Mock **seed** clears the stored address; sync again to restore links.

## Project layout

```
backend/          FastAPI, embeddings, Gmail sync, MongoDB
extension/        React + Vite → builds to ../dist
dist/             Load this folder in Chrome (after npm run build)
instruction.md    Planned features (hybrid search, chat, etc.)
```

## Troubleshooting

### “Could not reach the backend” / HTTP 503 in the popup

The extension used to show that message for **any** failure (including HTTP 500/503). It now shows the **real error text** from the API.

- **MongoDB / TLS (`TLSV1_ALERT_INTERNAL_ERROR`, `SSL handshake failed`, 503):** The API is up but the driver cannot complete TLS to Atlas. Try in order:
  1. **`pip install -r requirements.txt`** again (the app uses **Certifi** as `tlsCAFile`, which fixes many Windows/Python CA issues).
  2. **Restart** `python main.py` after upgrading deps.
  3. **VPN / corporate network / antivirus “HTTPS scanning”** — try another network or disable SSL inspection for Python briefly to confirm.
  4. **Newer Python** (3.11+) if you are on an old 3.10 build with an outdated OpenSSL.
  5. **Last resort (local dev only):** in `backend/.env` set `MONGODB_TLS_INSECURE=true` — relaxes TLS verification (**unsafe**; do not use for real data or production).
  6. **Local MongoDB:** `MONGODB_URI=mongodb://127.0.0.1:27017` (no Atlas TLS path).

  Check: `GET http://127.0.0.1:8000/health` should return `{"ok":true,"database":"up"}` when the DB is reachable.

- **No data:** Run `POST /emails/seed` or Gmail `POST /emails/sync` so `/ask` has documents to search.

### Hugging Face / PyTorch “UNEXPECTED … embeddings.position_ids”

Harmless when loading `all-MiniLM-L6-v2` on some stacks; it does **not** mean the HTTP server failed.

### Extension changes not applying

Rebuild (`npm run build`) and **Reload** the unpacked extension in Chrome.
