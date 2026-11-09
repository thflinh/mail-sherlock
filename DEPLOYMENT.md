# Deployment Guide

Production: **https://mailsherlock.space**

## Architecture

```
              Browser
                 │ HTTPS
                 ▼
              Cloudflare (proxy, SSL mode: Full (strict))
                 │ HTTPS
                 ▼
              AWS EC2 (t3.small, Ubuntu 24.04, Elastic IP)
              ┌─────────────────────────────┐
              │  nginx (port 80/443)        │  ← Let's Encrypt cert (certbot)
              │    ↓                        │
              │  Docker: FastAPI Backend    │  ← port 8000
              │  + serves React SPA         │  ← Vite builds to backend/static/
              └────────┬────────────────────┘
                       │
              MongoDB Atlas   +   Google Gemini AI
```

Production domain: **`https://mailsherlock.space`** (Cloudflare → nginx on EC2).

---

## Redeploy After Deleting EC2

Checked **2026-09-29**: `https://mailsherlock.space/ready` returns **Cloudflare 522** (origin unreachable). Old IP `35.81.149.107:8000` times out. The domain and Cloudflare proxy are still up; only the EC2 origin is gone.

### What must be renewed / updated

| Item | Why it breaks | What to do |
|---|---|---|
| **EC2 instance** | Deleted | Launch a new `t3.small` (prefer an **Elastic IP** so the public IP does not change again) |
| **Cloudflare DNS A record** | Still points at the dead origin IP | Cloudflare → DNS → update A record for `mailsherlock.space` to the **new EC2 public IP** (proxied/orange cloud OK) |
| **GitHub secret `EC2_HOST`** | SSH deploy target is the old IP | Repo → Settings → Secrets → Actions (and env `ec2-production`) → set to the new IP |
| **GitHub secret `EC2_SSH_KEY`** | New key pair if you created one | Paste the new `.pem` contents; keep `EC2_USER=ubuntu` |
| **GitHub secret `GH_PAT`** | Fine-grained / classic PATs expire | Renew if `git pull` in the deploy job fails with auth errors |
| **`BACKEND_URL` on the server** | OAuth redirect is built as `BACKEND_URL + /auth/callback` | Set `BACKEND_URL=https://mailsherlock.space` in `backend/.env` (not the raw EC2 IP) |
| **Let's Encrypt / certbot** | Certs lived on the deleted disk | After nginx is up: `sudo certbot --nginx -d mailsherlock.space` |
| **MongoDB Atlas Network Access** | Old EC2 IP was allowlisted | Add the new EC2 IP, or temporarily `0.0.0.0/0`. Also **Resume** the Atlas cluster if it was paused from inactivity |
| **Google OAuth redirect URIs** | Old IP URI is dead; domain URI is still valid | Keep `https://mailsherlock.space/auth/callback`. Remove `http://35.81.149.107:8000/auth/callback` if still listed. Keep localhost for local dev |
| **Gmail user tokens** | OAuth **Testing** refresh tokens expire after ~7 days idle | After redeploy, users must click Connect Gmail again |
| **`GEMINI_API_KEY`** | Usually still valid | Reuse unless revoked in Google AI Studio |
| **`GOOGLE_CREDENTIALS_JSON` / `MONGODB_URI`** | Client ID and DB URI do not expire with EC2 | Reuse the same values in the new `backend/.env` |

### Order of operations (shortest path)

1. Launch EC2 + security group (22, 80, 443, optionally 8000) → attach Elastic IP if possible.
2. Install Docker / nginx / certbot; clone repo; recreate `backend/.env` with:
   ```env
   MONGODB_URI=mongodb+srv://...
   GEMINI_API_KEY=...
   GOOGLE_CREDENTIALS_JSON={"web":{...}}
   BACKEND_URL=https://mailsherlock.space
   DB_MAIL=mail_sherlock
   ```
3. `docker build` + `docker run` (see Step 7 below); confirm `curl http://localhost:8000/ready`.
4. Point Cloudflare A record at the new IP; SSL/TLS mode = **Full** (not Flexible).
5. Configure nginx for `mailsherlock.space` → `certbot --nginx -d mailsherlock.space`.
6. Update Atlas IP allowlist + GitHub `EC2_HOST` / `EC2_SSH_KEY`.
7. Smoke test: `https://mailsherlock.space/ready` → 200, then Gmail OAuth login.

Until steps 1–5 are done, Cloudflare will keep returning **522**. CI deploy alone cannot revive the app — the instance and DNS origin must exist first.

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

### 1. Dockerfile builds the frontend ✓ Done

The `Dockerfile` has a Node stage that builds `web/` into `backend/static/`, then copies it into the Python image.

### 2. Fix hardcoded MongoDB URI ✓ Done

`backend/db.py` hardcoded fallback has been removed. `MONGODB_URI` must be set via env var.

### 3. CORS ✓ Done

`allow_origins=["*"]` — no changes needed.

---

## Step-by-Step: Deploy to AWS EC2

Commands on your PC are for **Git Bash** on Windows. Use forward slashes (`~/.ssh/mail-sherlock.pem`) — backslashes get eaten.

Check the prompt before running anything:
- `<you>@<pc> MINGW64` → your PC
- `ubuntu@ip-...` → the server

### Step 1 — Launch the instance (AWS console)

1. Pick a region (top-right of the console).
2. EC2 → **Launch instance**:
   - **Name**: `mail-sherlock`
   - **AMI**: **Ubuntu Server 24.04 LTS (HVM), SSD Volume Type**, architecture **64-bit (x86)**. Not the Ubuntu Pro, SQL Server, or Deep Learning images.
   - **Instance type**: `t3.small`. Double-check it — the default is `t3.micro` (1 GB), which runs out of memory.
   - **Key pair**: create new → RSA → `.pem`. Save it as `~/.ssh/mail-sherlock.pem`, never inside the repo. It can't be re-downloaded.
   - **Storage**: 30 GiB gp3 (Docker images + build cache need the room).

### Step 2 — Security group

In **Network settings → Edit**, create a security group with:

| Type | Port | Source | Purpose |
|---|---|---|---|
| SSH | 22 | 0.0.0.0/0 | SSH. Must be open to anywhere: the GitHub Actions deploy job connects from changing IPs. Login is key-only. |
| HTTP | 80 | 0.0.0.0/0 | Web traffic + certbot challenge |
| HTTPS | 443 | 0.0.0.0/0 | HTTPS traffic |

Port 8000 stays closed — nginx proxies to it locally.

### Step 3 — Attach an Elastic IP

EC2 → **Elastic IPs** → **Allocate Elastic IP address** → **Actions → Associate** → Instance: `mail-sherlock`. Leave **Private IP address** blank and **Reassociation** unchecked.

A fixed IP means the DNS record, Atlas allowlist, and GitHub secret survive instance stop/start. It's written as `<ELASTIC-IP>` below.

> Wrong instance type? **Instance state → Stop** → **Actions → Instance settings → Change instance type** → **Start**. Disk and Elastic IP are kept.

### Step 4 — SSH in (Git Bash, your PC)

```bash
chmod 400 ~/.ssh/mail-sherlock.pem
ssh -i ~/.ssh/mail-sherlock.pem ubuntu@<ELASTIC-IP>
```

On the server, confirm the size:
```bash
free -h    # Mem total ≈ 1.9Gi on t3.small (≈ 911Mi means t3.micro)
```

### Step 5 — Add 2 GB swap (server)

Safety margin so the torch install and model load don't OOM.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h    # Swap: 2.0Gi
```

### Step 6 — Install Docker, nginx, certbot (server)

```bash
sudo apt update && sudo DEBIAN_FRONTEND=noninteractive apt upgrade -y
sudo apt install -y docker.io git nginx certbot python3-certbot-nginx
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu
sudo reboot
```

Wait ~30 s, SSH in again (Step 4), then:
```bash
docker ps    # empty table, no "permission denied"
```

### Step 7 — Clone the repo (server)

```bash
cd ~ && git clone https://github.com/thflinh/mail-sherlock.git
```

It must live at `~/mail-sherlock` — the CI deploy job runs `cd mail-sherlock`.

### Step 8 — Create `backend/.env` (server)

`backend/.env` is gitignored, so it has to be created on the server:

```env
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
DB_MAIL=mail_sherlock
GEMINI_API_KEY=...
HF_TOKEN=...
GOOGLE_CREDENTIALS_JSON={"web":{...}}
BACKEND_URL=https://mailsherlock.space
```

- **No quotes around values.** `docker run --env-file` passes quotes through literally.
- **`BACKEND_URL`** must be the public HTTPS domain. The OAuth redirect is built as `BACKEND_URL + /auth/callback`.
- **`MONGODB_URI`**: Atlas → **Database → Clusters → Connect → Drivers** → copy the `mongodb+srv://` string. Replace `<db_password>` with the *database user's* password (reset it under **Security → Database Access**). URL-encode special characters, or use a letters-and-numbers password.
- **`GOOGLE_CREDENTIALS_JSON`**: the whole OAuth client JSON on one line.

Either paste it in with `nano ~/mail-sherlock/backend/.env`, or prepare the file on your PC (outside the repo) and upload it:

```bash
# Git Bash, your PC
scp -i ~/.ssh/mail-sherlock.pem path/to/prod.env ubuntu@<ELASTIC-IP>:~/mail-sherlock/backend/.env
```

Verify on the server:
```bash
cd ~/mail-sherlock
sed -i 's/\r$//' backend/.env      # strip Windows line endings
chmod 600 backend/.env
cut -d= -f1 backend/.env           # expect the 6 names above
grep -cE '=["'\'']' backend/.env    # expect 0 (no quoted values)
grep '^GOOGLE_CREDENTIALS_JSON=' backend/.env | cut -d= -f2- | python3 -m json.tool > /dev/null && echo JSON OK
```

### Step 9 — MongoDB Atlas network access

Atlas → **Network Access** → **Add IP Address** → `<ELASTIC-IP>/32`. If the cluster shows **Paused**, click **Resume**.

Do this before Step 10, or the container can't reach the database.

### Step 10 — Build and run (server)

```bash
tmux                               # keeps the build alive if SSH drops; reattach with: tmux attach
cd ~/mail-sherlock
docker build -t mail-sherlock .    # ~10 min the first time
docker run -d \
  --name mail-sherlock \
  --restart unless-stopped \
  --env-file backend/.env \
  -p 8000:8000 \
  mail-sherlock
docker logs -f mail-sherlock       # wait for "Uvicorn running on http://0.0.0.0:8000", then Ctrl+C
curl -i http://localhost:8000/ready    # expect 200
```

### Step 11 — nginx reverse proxy (server)

Use the repo's `nginx.conf` (disables buffering for SSE streaming, 120 s timeouts for Gemini calls):

```bash
sudo cp ~/mail-sherlock/nginx.conf /etc/nginx/sites-available/mail-sherlock
sudo sed -i 's/server_name _;/server_name mailsherlock.space;/' /etc/nginx/sites-available/mail-sherlock
sudo ln -s /etc/nginx/sites-available/mail-sherlock /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
curl -i -H "Host: mailsherlock.space" http://localhost/ready    # expect 200
```

### Step 12 — Point Cloudflare DNS at the server (DNS only for now)

Cloudflare → `mailsherlock.space` → **DNS → Records**:
- **A** record `mailsherlock.space` → `<ELASTIC-IP>`, Proxy status **DNS only (grey cloud)**.
- Delete any other A/AAAA records for the root domain.

It must be grey for now: with the orange cloud on, Cloudflare redirects HTTP → HTTPS before the request reaches the server, and certbot's check fails.

Verify from your PC:
```bash
nslookup mailsherlock.space 1.1.1.1     # expect only <ELASTIC-IP>; 104.21.x / 172.67.x means still proxied
curl -i http://mailsherlock.space/ready # expect 200 with "Server: nginx"
```

### Step 13 — HTTPS certificate (server)

```bash
sudo certbot --nginx -d mailsherlock.space --redirect --agree-tos --register-unsafely-without-email -n
sudo certbot renew --dry-run    # expect "all simulated renewals succeeded"
```

Certbot renews automatically. The email is optional (Let's Encrypt no longer sends expiry emails). If you pass `-m`, it must be on a real domain — `example.com` is rejected.

### Step 14 — Turn the Cloudflare proxy back on

1. **SSL/TLS → Overview** → encryption mode **Full (strict)**.
2. **DNS** → the A record → **Proxied (orange cloud)**.

```bash
curl -i https://mailsherlock.space/ready    # expect HTTP/2 200
```

### Step 15 — Google OAuth redirect URI

Google Cloud Console → **APIs & Services → Credentials** → your OAuth client → **Authorized redirect URIs** must include:
```
https://mailsherlock.space/auth/callback
```
Keep `http://localhost:8000/auth/callback` for local dev.

### Step 16 — GitHub Actions deploy secrets (Git Bash, your PC)

Run from the repo folder. Setting secrets needs admin access on the repo.

```bash
gh secret set EC2_HOST    --env ec2-production --repo thflinh/mail-sherlock --body <ELASTIC-IP>
gh secret set EC2_SSH_KEY --env ec2-production --repo thflinh/mail-sherlock < ~/.ssh/mail-sherlock.pem
gh secret set EC2_USER    --env ec2-production --repo thflinh/mail-sherlock --body ubuntu
```

`GH_PAT` (used by the deploy job's `git pull`) expires. If a deploy fails on `git pull` with an auth error, create a new token and update that secret.

### Step 17 — Test the deploy

- [ ] `https://mailsherlock.space/ready` returns 200
- [ ] `https://mailsherlock.space` loads the app
- [ ] Connect Gmail → Google login → back to the app (`redirect_uri_mismatch` → see Step 15)
- [ ] Emails sync correctly
- [ ] AI query returns results

---

## Updating the App

### Automatic (default)

Every push or merge to `main` runs `.github/workflows/ci.yml`. If lint, typecheck, frontend build, and syntax check pass, the `deploy` job SSHes into `EC2_HOST` and runs `git pull` → `docker build` → replaces the container → polls `/ready` for up to 2 minutes.

Watch a run:
```bash
gh run watch --repo thflinh/mail-sherlock
```

- **Downtime:** ~1–2 min per deploy. The old container stops before the new one is ready.
- **Only code deploys.** `backend/.env` and the nginx config on the server are edited by hand:
  - After editing `backend/.env`, recreate the container (stop, rm, run — see Manual below). `docker restart` does **not** re-read `--env-file`.
  - After editing nginx config: `sudo nginx -t && sudo systemctl reload nginx`.
- **Disk:** each build leaves the previous image behind as `<none>`. Usually tens of MB; ~2–3 GB when `requirements.txt` changes (new torch layer). Free it with `docker image prune -f`, check with `df -h /`.

### Manual (if CI is broken)

```bash
ssh -i ~/.ssh/mail-sherlock.pem ubuntu@<ELASTIC-IP>
cd ~/mail-sherlock
git pull
docker build -t mail-sherlock .
docker stop mail-sherlock && docker rm mail-sherlock
docker run -d \
  --name mail-sherlock \
  --restart unless-stopped \
  --env-file backend/.env \
  -p 8000:8000 \
  mail-sherlock
docker image prune -f
```

> See `CICD.md` for how the GitHub Actions pipeline is set up.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Identity file /c/Users/<you>.sshmail-sherlock.pem not accessible` | Backslashes in Git Bash | Use `~/.ssh/mail-sherlock.pem` |
| `docker ps` → `npipe:////./pipe/dockerDesktopLinuxEngine` | Ran on your PC, not the server | SSH in first; prompt must be `ubuntu@...` |
| `free -h` shows ~911Mi | Instance is `t3.micro` | Change instance type (note under Step 3) |
| `curl http://mailsherlock.space/...` → `301` with `Server: cloudflare` | Cloudflare proxy still on | Step 12: grey cloud |
| Cloudflare error 522 | Origin unreachable | Instance running? A record = Elastic IP? Ports 80/443 open? |
| certbot: "invalid email address" | Placeholder email | Use `--register-unsafely-without-email` |
| Container logs show MongoDB timeout | Atlas allowlist missing or cluster paused | Step 9 |
| Google `redirect_uri_mismatch` | Redirect URI missing or wrong `BACKEND_URL` | Steps 15 and 8 |

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
3. Under **Authorized redirect URIs**, add the production URL:
   ```
   https://mailsherlock.space/auth/callback
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
