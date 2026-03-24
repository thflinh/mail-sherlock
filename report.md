# mail-sherlock — file purpose reference

This report describes the **purpose** and **function** of project-owned files (not third-party libraries under `venv/`, `node_modules/`, or `.venv/`).

---

## Repository root

| File / folder | Purpose | Function |
|---------------|---------|----------|
| **`README.md`** | Primary documentation | How to run the backend and extension, configure MongoDB (local Docker vs Atlas), Gmail OAuth, troubleshooting (TLS, PowerShell vs `curl`), extension build/load paths. |
| **`instruction.md`** | Product / engineering roadmap | Planned enhancements: hybrid search (semantic + keyword), conversational chat API, richer Gmail sync (e.g. MIME handling), success criteria—not the live implementation spec. |
| **`alreadydid.txt`** | Project memo | High-level idea, stack summary, and run checklist aligned with the repo (FastAPI, Mongo, extension, `dist/` load path). |
| **`report.md`** | This document | Inventory of files and what each is for. |
| **`docker-compose.yml`** | Local database | Runs **MongoDB 7** on port **27017** with a persistent volume—used when Atlas TLS is problematic or for offline dev. |
| **`.gitignore`** | Git exclusions | Ignores secrets and generated artifacts: `.env`, `credentials.json`, `token.json`, Python caches, `node_modules`, `dist/`, venv folders. |
| **`venv/`** (if present) | Python env | Optional project-level virtual environment; not committed. |

---

## `backend/` — Python API

| File | Purpose | Function |
|------|---------|----------|
| **`main.py`** | FastAPI application | Defines HTTP routes: **`/` health** (`/health`), **semantic search** (`POST /ask`) using embeddings + cosine similarity, **OAuth** (`/auth/login`, `/auth/callback`) for Gmail, **Gmail sync** (`POST /emails/sync`) up to 500 messages, **mock seed** (`POST /emails/seed`). Manages in-memory OAuth `state`, stores OAuth `token.json`, writes `settings` for OAuth Gmail address, attaches **precomputed embeddings** on sync/seed for fast search. |
| **`db.py`** | MongoDB connection | Loads **`MONGODB_URI`**, **`DB_MAIL`** from environment; builds `AsyncIOMotorClient` with **Certifi** CA bundle for TLS Atlas; optional **`MONGODB_TLS_INSECURE`** for dev; `connect_db` / `close_db` / `get_db` lifecycle. |
| **`embeddings.py`** | ML model | Loads **SentenceTransformer** `all-MiniLM-L6-v2`; **`encode()`** for text → normalized vectors; **`cosine_similarity`** as dot product; **`add_embeddings_inplace()`** / **`embeddings_ready()`** / **`document_search_text()`** for stored vectors and search. |
| **`emails.json`** | Mock data | JSON array of sample emails (subject, body, etc.) for demos and **`/emails/seed`** when Gmail is not used. |
| **`requirements.txt`** | Python dependencies | Pins FastAPI, uvicorn, sentence-transformers, torch, motor, pymongo, certifi, google APIs, etc. |
| **`static/index.html`** | Marketing landing | Dark, minimal “sherlock” themed page served at **`GET /`**; CTA links to **`/auth/login`**. |
| **`static/oauth_success.html`** | OAuth success UI | Shown after **`/auth/callback`** saves `token.json` (replaces raw JSON). |
| **`static/oauth_error.html`** | OAuth error UI | Template for failed callback (missing params, bad state, token exchange error). |
| **`.env`** *(local, gitignored)* | Secrets / config | `MONGODB_URI`, optional `MONGODB_TLS_INSECURE`, `DB_MAIL`. |
| **`credentials.json`** *(local, gitignored)* | Google OAuth client | OAuth **client ID/secret** JSON from Google Cloud Console for Gmail API—**not** end-user mail content. |
| **`token.json`** *(local, gitignored)* | OAuth refresh token | Written after successful **`/auth/callback`**; authorizes **`/emails/sync`** for the user who completed login on this machine. |

---

## `extension/` — Chrome extension (React + Vite)

| File | Purpose | Function |
|------|---------|----------|
| **`package.json`** | npm manifest | Scripts (`dev`, `build`, `preview`), React 18, Vite, TypeScript tooling. |
| **`package-lock.json`** | Lockfile | Exact dependency versions for reproducible installs. |
| **`tsconfig.json`** | TypeScript config | Compiler options for the extension sources. |
| **`vite.config.ts`** | Build config | **`base: "./"`** for extension-friendly asset paths; **`outDir: ../dist`** builds into repo-root **`dist/`**; multi-page input for **`popup.html`**. |
| **`public/manifest.json`** | Chrome MV3 manifest | Extension name, `default_popup` path, **`host_permissions`** for `127.0.0.1:8000`, `localhost` API, and `mail.google.com` for “Open in Gmail” links. |
| **`src/main.tsx`** | React entry | Mounts **`App`** into the popup DOM root. |
| **`src/popup/popup.html`** | Popup shell | HTML shell for the toolbar popup; loads Vite dev or built JS bundle. |
| **`src/popup/App.tsx`** | Main UI | Search input, loading/error states, calls **`searchEmails`**, renders **`ResultCard`** list; tracks **`gmailAuthEmail`** from API for correct Gmail links. |
| **`src/popup/App.css`** | Popup styles | Layout and dark theme (~380px width). |
| **`src/popup/ResultCard.tsx`** | Result row | One email card: subject, sender, date, snippet, score; **clickable** link to Gmail when **`threadId`** + **`gmailAuthEmail`** are present. |
| **`src/api/search.ts`** | API client | **`POST /ask`** to `http://127.0.0.1:8000`; parses errors; **`gmailWebUrlForThread()`** builds Gmail `authuser` URLs; TypeScript types for responses. |

---

## `dist/` — built extension (generated)

| Content | Purpose | Function |
|---------|---------|----------|
| **`dist/`** (after `npm run build`) | Load unpacked target | Chrome **Load unpacked** should point here— **`manifest.json`**, bundled JS/CSS, **`popup.html`**. Regenerated by Vite; listed in `.gitignore`. |

---

## Data flow (how files relate)

1. **Extension** (`search.ts` → `App.tsx`) sends **`POST /ask`** to **`main.py`**.
2. **`main.py`** reads emails from **MongoDB** (`db.py`), uses **vectors** from **`embeddings.py`** (or encodes on legacy rows).
3. **Gmail sync** uses **`credentials.json`** + **`token.json`** + Gmail API; **Mongo** stores messages + embeddings + optional **`settings`** OAuth email.
4. **Mock path** uses **`emails.json`** via **`/emails/seed`** instead of Gmail.

---

## Documents vs code

| Path | Role |
|------|------|
| **`instruction.md`** | Future / planned features (hybrid search, chat, etc.). |
| **`README.md`** + **`alreadydid.txt`** | How to run and operate the current app. |
| **`report.md`** | This file map. |

---

## Do not commit (local / generated)

| Path | Why |
|------|-----|
| **`venv/`**, **`.venv/`**, **`env/`**, **`backend/env/`** | Python virtualenvs — huge (`torch`, etc.), machine-specific. Recreate with `python -m venv` + `pip install -r requirements.txt`. |
| **`node_modules/`**, **`extension/node_modules/`** | npm dependencies — use `npm install` after clone. |
| **`dist/`** | Vite build output — run `npm run build` in `extension/`. |
| **`backend/.env`**, **`backend/credentials.json`**, **`backend/token.json`** | Secrets and OAuth tokens — keep local only (see `.gitignore`). |
| **`__pycache__/`**, **`*.pyc`** | Python bytecode — regenerated automatically. |

---

*Generated for the mail-sherlock codebase; adjust if new files are added.*
