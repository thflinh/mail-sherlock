# Deployment Guide

## Architecture

```
              AWS EC2 (t3.small, Docker)
              ┌─────────────────────────────┐
              │  nginx (port 80/443)        │  ← HTTPS termination
              │    ↓                        │
              │  FastAPI Backend            │
              │  + serves React SPA         │  ← Vite builds to backend/static/
              └────────┬────────────────────┘
                       │
              MongoDB Atlas   +   Google Gemini AI
```

---

## Instance Recommendation

| Instance | RAM | vCPU | Cost | Notes |
|---|---|---|---|---|
| t2.micro | 1 GB | 1 | Free (12 mo) | Risky — torch may OOM |
| **t3.small** | **2 GB** | **2** | **~$15/mo** | **Recommended** |
| t3.medium | 4 GB | 2 | ~$30/mo | Comfortable headroom |

Use **t3.small** minimum. `torch` + `sentence-transformers` alone consume ~800 MB at runtime.

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

### 2. Fix hardcoded MongoDB URI ✓ Done

`backend/db.py` hardcoded fallback has been removed. `MONGODB_URI` must be set via env var.

### 3. CORS ✓ Done

`allow_origins=["*"]` — no changes needed.

---

## Step-by-Step: Launch AWS EC2

### Step 1 — Launch the instance

1. Go to [console.aws.amazon.com/ec2](https://console.aws.amazon.com/ec2)
2. Click **Launch instance**
3. Configure:
   - **Name**: `mail-sherlock`
   - **AMI**: Ubuntu Server 22.04 LTS
   - **Instance type**: `t3.small`
   - **Key pair**: create a new one, download the `.pem` file — save it, you can't re-download
   - **Storage**: 20 GB gp3 (default is 8 GB, not enough for Docker images)

### Step 2 — Configure security group

In the **Network settings** section, add these inbound rules:

| Type | Port | Source | Purpose |
|---|---|---|---|
| SSH | 22 | My IP | SSH access |
| HTTP | 80 | 0.0.0.0/0 | Web traffic |
| HTTPS | 443 | 0.0.0.0/0 | HTTPS traffic |
| Custom TCP | 8000 | 0.0.0.0/0 | Direct app access (temporary) |

### Step 3 — SSH into the instance

```bash
chmod 400 your-key.pem
ssh -i your-key.pem ubuntu@<EC2-PUBLIC-IP>
```

The public IP is shown in EC2 → Instances → your instance.

### Step 4 — Install Docker

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-v2 git nginx certbot python3-certbot-nginx
sudo systemctl enable docker
sudo usermod -aG docker ubuntu
newgrp docker
```

### Step 5 — Clone the repo

```bash
git clone https://github.com/your-username/mail-sherlock.git
cd mail-sherlock
```

### Step 6 — Create the .env file on the server

```bash
nano backend/.env
```

Paste your environment variables:

```env
MONGODB_URI=mongodb+srv://...
GEMINI_API_KEY=...
GOOGLE_CREDENTIALS_JSON={"web":{...}}
BACKEND_URL=http://<EC2-PUBLIC-IP>:8000
DB_MAIL=mail_sherlock
```

> Set `BACKEND_URL` to your EC2 IP for now. Update to your domain after HTTPS is set up.

### Step 7 — Build and run with Docker

```bash
docker build -t mail-sherlock .
docker run -d \
  --name mail-sherlock \
  --restart unless-stopped \
  --env-file backend/.env \
  -p 8000:8000 \
  mail-sherlock
```

Verify it's running:
```bash
docker ps
curl http://localhost:8000/ready
```

### Step 8 — Set up nginx as reverse proxy

```bash
sudo nano /etc/nginx/sites-available/mail-sherlock
```

Paste:

```nginx
server {
    listen 80;
    server_name <EC2-PUBLIC-IP>;  # replace with your domain later

    location / {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/mail-sherlock /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

App is now accessible at `http://<EC2-PUBLIC-IP>`.

### Step 9 — Set up HTTPS with a domain (optional but recommended)

If you have a domain name, point its A record to your EC2 IP, then:

```bash
sudo certbot --nginx -d yourdomain.com
```

Certbot auto-configures nginx for HTTPS and auto-renews the certificate.

Update `BACKEND_URL` in your `.env`:
```
BACKEND_URL=https://yourdomain.com
```

Then restart the container:
```bash
docker restart mail-sherlock
```

### Step 10 — Update Google OAuth redirect URI

In Google Cloud Console → Credentials → your OAuth client → Authorized redirect URIs, add:
```
http://<EC2-PUBLIC-IP>/auth/callback
```
Or if using a domain:
```
https://yourdomain.com/auth/callback
```

### Step 11 — MongoDB Atlas IP whitelist

In Atlas → Network Access → Add IP Address:
- Allow `0.0.0.0/0` (all IPs), or
- Add your EC2 public IP specifically

### Step 12 — Test the deploy

- [ ] `curl http://<EC2-PUBLIC-IP>/ready` returns 200
- [ ] OAuth login flow works end-to-end
- [ ] Emails sync correctly
- [ ] AI query returns results

---

## Updating the App (manual)

When you push new code and want to redeploy:

```bash
ssh -i your-key.pem ubuntu@<EC2-PUBLIC-IP>
cd mail-sherlock
git pull
docker build -t mail-sherlock .
docker stop mail-sherlock && docker rm mail-sherlock
docker run -d \
  --name mail-sherlock \
  --restart unless-stopped \
  --env-file backend/.env \
  -p 8000:8000 \
  mail-sherlock
```

> See `CICD.md` to automate this with GitHub Actions.

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
3. Under **Authorized redirect URIs**, add your EC2 URL:
   ```
   http://<EC2-PUBLIC-IP>/auth/callback
   ```
4. Keep `http://localhost:8000/auth/callback` for local dev
5. Click **Save**

### Step 5: Export `credentials.json` as an env var

1. In Google Cloud Console → **Credentials** → click your OAuth client
2. Click **Download JSON**
3. Open the file and copy the entire contents
4. Add to `backend/.env` on the EC2 server:
   - Key: `GOOGLE_CREDENTIALS_JSON`
   - Value: paste the full JSON on one line

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
