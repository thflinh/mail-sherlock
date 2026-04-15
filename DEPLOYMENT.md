# Deployment Guide

## Architecture

```
Chrome Extension  →  (localhost for dev, prod URL for release)
                          ↓
              Railway (Dockerfile)
              ┌─────────────────────┐
              │  FastAPI Backend    │
              │  + serves React SPA │  ←  Vite builds to backend/static/
              └────────┬────────────┘
                       │
              MongoDB Atlas   +   Google Gemini AI
```

---

## Pre-Deploy Checklist

### 1. Fix the Dockerfile — build frontend inside it

The current `Dockerfile` only installs the Python backend. Add a Node build stage so the React frontend gets built and served:

```dockerfile
# Stage 1: build frontend
FROM node:20-slim AS frontend
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Python backend
FROM python:3.11-slim
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY --from=frontend /web/../backend/static backend/static
EXPOSE 8000
CMD uvicorn main:app --app-dir backend --host 0.0.0.0 --port ${PORT:-8000}
```

### 2. Set environment variables on Railway

Go to Railway project → Variables and set:

| Variable | Value |
|---|---|
| `GEMINI_API_KEY` | Your Gemini API key |
| `GOOGLE_CREDENTIALS_JSON` | Full contents of `credentials.json` |
| `BACKEND_URL` | `https://your-app.up.railway.app` (set after first deploy) |
| `MONGODB_URI` | Your Atlas connection string |

### 3. Fix hardcoded MongoDB URI

`backend/db.py` has a plaintext MongoDB URI as the default fallback. Remove it and require the env var.

### 4. MongoDB Atlas — whitelist Railway IPs

In Atlas → Network Access, either:
- Allow `0.0.0.0/0` (all IPs), or
- Add Railway's static outbound IPs

### 5. Update CORS in main.py

Make sure `allow_origins` includes your Railway domain.

### 6. Test the deploy

- [ ] `/ready` returns 200
- [ ] OAuth login flow works end-to-end
- [ ] Emails sync correctly
- [ ] AI query returns results

---

## Google OAuth — Option 2: Test Users (up to 100, no verification needed)

Instead of going through Google's 1–4 week OAuth verification process, keep the app in **Testing** mode and manually add allowed users. Test users get the full normal login experience with no warning screens.

### Step 1: Go to Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Make sure you are in the **correct project** — the one where your `credentials.json` was created

### Step 2: Configure OAuth Consent Screen

1. Left sidebar → **APIs & Services** → **OAuth consent screen**
2. Fill in if not already set:
   - **App name**: `Mail Sherlock`
   - **User support email**: your Gmail
   - **Developer contact email**: your Gmail
3. Save and continue through all steps
4. Make sure **Publishing status** is set to **Testing** (not "In production")

### Step 3: Add Test Users

1. On the OAuth consent screen page, scroll to **Test users**
2. Click **+ Add Users**
3. Enter Gmail addresses (up to 100 total)
4. Click **Save**

These users can log in with no warning. Anyone not on the list gets:
> "Error 403: access\_denied"

### Step 4: Update OAuth Redirect URI

1. Left sidebar → **APIs & Services** → **Credentials**
2. Click your **OAuth 2.0 Client ID**
3. Under **Authorized redirect URIs**, add:
   ```
   https://your-app.up.railway.app/auth/callback
   ```
4. Keep `http://localhost:8000/auth/callback` for local dev
5. Click **Save**

### Step 5: Set `BACKEND_URL` on Railway

After your first deploy, copy the Railway-assigned URL and set:
```
BACKEND_URL=https://your-app.up.railway.app
```
This is used by `main.py` to construct the OAuth redirect URI.

### Step 6: Export `credentials.json` as an env var

1. In Google Cloud Console → **Credentials** → click your OAuth client
2. Click **Download JSON**
3. Open the file and copy the entire contents
4. In Railway → Variables:
   - Key: `GOOGLE_CREDENTIALS_JSON`
   - Value: paste the full JSON

---

## Chrome Extension

The extension currently points to `http://127.0.0.1:8000` (local only). For a published extension:

1. Update `extension/src/api/search.ts` and `extension/src/background/background.ts`:
   ```ts
   const API_URL = "https://your-app.up.railway.app";
   ```
2. Update `extension/public/manifest.json` host permissions to include the production URL
3. Rebuild: `npm run build` in `/extension`
4. Zip the `dist/` folder

To publish on Chrome Web Store:
- Create a developer account at `chrome.google.com/webstore/devconsole`
- One-time $5 registration fee
- Submit the zip with screenshots, description, and privacy policy

---

## What the Login Flow Looks Like for Test Users

```
User visits the app
      ↓
Clicks "Connect Gmail"
      ↓
Redirected to Google login
      ↓
Normal account picker (no warning screen)
      ↓
Grants gmail.readonly permission
      ↓
Redirected back to app ✓
```
