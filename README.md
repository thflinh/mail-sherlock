# mail-sherlock

Semantic search over email: a **FastAPI** backend (embeddings + MongoDB) and a **React web UI** (`web/`) that talks to the API—either via Vite dev proxy or after building into `backend/static/` for production.

## Prerequisites

- **Python 3.10+** (3.11 recommended)
- **Node.js 18+** and npm
- **MongoDB** reachable from your machine ([MongoDB Atlas](https://www.mongodb.com/atlas) or local)

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

**Force local MongoDB** (ignores `MONGODB_URI` — use with `docker compose` when Atlas TLS fails on your machine):

```env
MONGODB_USE_LOCAL=1
# optional: MONGODB_LOCAL_URI=mongodb://127.0.0.1:27017
```

**Local MongoDB (recommended when Atlas TLS fails on your PC):** from the **repo root** (with [Docker Desktop](https://www.docker.com/products/docker-desktop/) running):

```bash
docker compose up -d
```

Then in `backend/.env` use `MONGODB_URI=mongodb://127.0.0.1:27017` (the repo’s `.env` is set up this way by default for dev).

If `docker compose` errors about `dockerDesktopLinuxEngine`, start **Docker Desktop** and wait until it is fully up, then run `docker compose up -d` again.

If `MONGODB_URI` is missing, the app uses **`mongodb://127.0.0.1:27017`** (local MongoDB). Prefer setting your own URI for Atlas/production and **do not commit secrets**.

**Gmail (optional):** put the Google OAuth client JSON in `backend/credentials.json` (see **Real Gmail** below).

**Start the API:**

```bash
python main.py
```

Or: `uvicorn main:app --reload --host 0.0.0.0 --port 8000`

API base: **http://localhost:8000**

**Landing page:** open **`http://localhost:8000/`** (or `http://127.0.0.1:8000/`) in a browser for a short product intro, setup notes, and **Authorize Gmail** (same host as `/auth/login`).

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

   Expect `synced` with a number (up to **500** latest messages per sync). Search then uses **your** mail; **Open in Gmail** links in the UI work when `threadId` is stored.

If sync returns **401**, do step 6 again. If **login** returns **500** about missing credentials, add `credentials.json`. If Google shows **redirect_uri_mismatch**, fix the URI in Cloud Console to match step 2 exactly.

#### “Access blocked” / **Error 403: access_denied** (Testing mode)

While the OAuth app is in **Testing** (default for new projects), **only** Google accounts listed as **Test users** can click **Authorize Gmail**. Everyone else gets *Mail Sherlock has not completed the Google verification process* / *only accessed by developer-approved testers*.

**Let a specific person use the app (quick fix):**

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **OAuth consent screen**.
2. Scroll to **Test users** → **+ Add users**.
3. Add their full Gmail address (e.g. `friend@gmail.com`) → **Save**.

They can try **Authorize Gmail** again (they may need to pick the right Google account).

**Let any Google account use it (production):**

1. Same **OAuth consent screen** → **Publishing status** → **Publish app** (confirm the dialog).
2. Gmail uses **sensitive/restricted** scopes. For the general public, Google usually requires **[OAuth verification](https://support.google.com/cloud/answer/9110914)** (privacy policy, app homepage, sometimes a demo video). Until verification is approved, users may see extra warnings or limits depending on scope and audience.

For a **small team**, adding Test users is enough; for **public** distribution, plan for verification and a privacy policy URL on the consent screen.

First run downloads the sentence-transformer model (~90MB+); startup can take a minute.

**Search speed:** Each email’s embedding is computed **once** when you **`POST /emails/seed`** or **`POST /emails/sync`** and stored in MongoDB. **`POST /ask`** then only encodes your query, so search is much faster than re-encoding every message each time. Re-run seed/sync after upgrading this logic so stored docs include `embedding`.

## 2. Web UI

**Development** (hot reload; API proxied to the backend on port 8000):

```bash
cd web
npm install
npm run dev
```

Open the URL Vite prints (usually **`http://localhost:5173`**). Keep **`python main.py`** (or uvicorn) running on **8000** so the proxy can reach the API.

**Production-style** (bundle served by FastAPI from `backend/static/`):

```bash
cd web
npm install
npm run build
```

Then start the backend and use **`http://localhost:8000/`** as usual—the landing and app assets come from `backend/static/`.

## 3. Use it

1. Backend running on port **8000** (and web UI via **`npm run dev`** or a fresh **`npm run build`** as above).
2. Open the app in your browser and run a natural-language search.

After **Gmail sync**, search responses include **`gmailAuthEmail`** (the address that completed OAuth in your browser session). **Open in Gmail** uses Google’s `authuser=` with that address so the correct account opens—not the default `/u/0` slot. Mock **seed** clears the stored address for that same session; sync again to restore links.

### Multi-user privacy on a shared backend

If you deploy one backend for multiple people (for example on EC2), mail-sherlock now isolates data by a per-browser session cookie:

- OAuth token storage is scoped to the session.
- Synced emails are tagged with the session owner and only searchable by that session.
- `gmailAuthEmail` is returned from the current session only.

This prevents one user from seeing another user’s connected Gmail address or indexed email results.

## Project layout

```
backend/          FastAPI, embeddings, Gmail sync, MongoDB; serves built web from static/
web/              React + Vite → production build writes to backend/static/
instruction.md    Planned features (hybrid search, chat, etc.)
```

## Troubleshooting

### “Could not reach the backend” / HTTP 503 in the browser

If the UI shows a connection or HTTP error, check the **real error text** from the API response and the browser devtools **Network** tab.

- **MongoDB / TLS (`TLSV1_ALERT_INTERNAL_ERROR`, `SSL handshake failed`, 503):** The API is up but the driver cannot complete TLS to Atlas. Try in order:
  1. **Local MongoDB:** `docker compose up -d` from the repo root, then in `backend/.env` set **`MONGODB_USE_LOCAL=1`** (or `MONGODB_URI=mongodb://127.0.0.1:27017`) and restart the API — bypasses Atlas TLS entirely.
  2. **TLS knobs (Atlas only):** in `backend/.env` try `MONGODB_TLS_DISABLE_OCSP=1`, then add `MONGODB_TLS_DISABLE_CRL=1`, then `MONGODB_FORCE_IPV4=1` (restart after each). Optional custom CA: `MONGODB_TLS_CA_FILE=C:\\path\\to\\corp-ca.pem`.
  3. **`pip install -r requirements.txt`** again (the app uses **Certifi** as `tlsCAFile`, which fixes many Windows/Python CA issues).
  4. **Restart** `python main.py` after upgrading deps.
  5. **VPN / corporate network / antivirus “HTTPS scanning”** — try another network or disable SSL inspection for Python briefly to confirm.
  6. **Newer Python** (3.11+) if you are on an old 3.10 build with an outdated OpenSSL.
  7. **Last resort (local dev only):** `MONGODB_TLS_INSECURE=true` — relaxes TLS verification (**unsafe**; do not use for real data or production).

  Check: `GET http://127.0.0.1:8000/health` should return `{"ok":true,"database":"up"}` when the DB is reachable.

- **No data:** Run `POST /emails/seed` or Gmail `POST /emails/sync` so `/ask` has documents to search.

### `KeyboardInterrupt` or long hangs while the server “reloads”

With **`uvicorn --reload`** (or `python main.py` when it enables reload), each restart **re-imports** the app. The ML stack is heavy; if you press **Ctrl+C** or save files repeatedly during that window, you can see **`KeyboardInterrupt`** deep inside `transformers` / `huggingface_hub` — that is the reload being interrupted, not a broken install.

**Mitigations:**

- Wait until you see **`Application startup complete`** before hitting OAuth again.
- For a faster, calmer dev loop, run **without** auto-reload:  
  `uvicorn main:app --host 0.0.0.0 --port 8000`  
  (no `--reload`). Restart manually after code changes.
- The embedding model is loaded **on first search or seed/sync** that needs it, so the API process starts quickly; the **first** `/ask` or embed after startup may still take a moment while PyTorch loads.

### Hugging Face / PyTorch “UNEXPECTED … embeddings.position_ids”

Harmless when loading `all-MiniLM-L6-v2` on some stacks; it does **not** mean the HTTP server failed.

### Web UI changes not applying

After `npm run build`, restart the backend if needed so it picks up new files under `backend/static/`. In dev, Vite reloads automatically.
