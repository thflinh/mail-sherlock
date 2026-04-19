# Deployment — What We Did & Why

A full explanation of every step taken to deploy Mail Sherlock to production.

---

## 1. The Overall Architecture

```
Browser
  ↓ HTTPS
Cloudflare  (CDN + DDoS protection)
  ↓ HTTPS
nginx on EC2  (reverse proxy)
  ↓ HTTP (internal)
FastAPI app on port 8000  (your Python backend)
  ↓
MongoDB Atlas  +  Google Gemini AI
```

Each layer has a specific job. Understanding why each exists is the key to understanding deployment.

---

## 2. AWS EC2

**What it is:** A virtual machine (server) running in AWS's data center. You rent it by the hour.

**Why we used it:**
- Your app uses `torch` and `sentence-transformers` (large ML libraries) that need to be **always running** in memory
- Serverless platforms (Vercel, AWS Lambda) spin down when idle and cold-start on the next request — with torch, that's 30–60 seconds, which causes timeouts
- EC2 is a real VM that stays on 24/7

**What we chose:** `t3.small` — 2 GB RAM, 2 vCPUs, ~$15/month
- `t2.micro` (free tier) only has 1 GB RAM — torch alone uses ~800 MB, so it would run out of memory
- `t3.small` gives enough headroom

**Ubuntu 24.04 LTS:**
- LTS = Long Term Support — security updates until 2029
- `apt` package manager makes installing Docker/nginx/certbot simple
- Most tutorials and Stack Overflow answers use Ubuntu

---

## 3. Security Groups

**What it is:** AWS's firewall for your EC2 instance. Controls which ports accept traffic.

**What we opened:**

| Port | Protocol | Why |
|---|---|---|
| 22 | SSH | So you can connect to the server from your laptop |
| 80 | HTTP | Web traffic (redirected to HTTPS) |
| 443 | HTTPS | Secure web traffic |
| 8000 | TCP | Direct app access (for testing) |

**Why port 22 matters:** Without it, you can't SSH in. If you accidentally delete this rule, you're locked out of your own server.

---

## 4. SSH (Secure Shell)

**What it is:** A protocol for securely connecting to a remote server over the internet. Like a terminal that runs on the EC2 machine instead of your laptop.

**How it works:**
- You have a `.pem` file (private key) — your identity proof
- AWS has the matching public key on the EC2 instance
- When you connect, SSH verifies your private key matches the public key
- No password needed — the key pair IS the authentication

**Why `chmod 400`:** Makes the key file read-only to you, no one else. SSH refuses to use a key file that others can read — it's a security requirement.

**The command:**
```bash
ssh -i "/path/to/key.pem" ubuntu@<IP>
```
- `-i` = identity file (your private key)
- `ubuntu` = the default user on Ubuntu AMIs
- `<IP>` = your EC2 public IP

---

## 5. Docker

**What it is:** A tool that packages your app and all its dependencies into a self-contained unit called a **container**. The container runs the same way on any machine.

**Why we used it:**
- Your app has complex dependencies (Python 3.11, torch, sentence-transformers, Node.js for the frontend build)
- Without Docker, you'd have to manually install all of these on the EC2 instance and hope versions match
- With Docker, you define everything in a `Dockerfile` and it just works

**Multi-stage Dockerfile explained:**

```dockerfile
# Stage 1: Build the React frontend
FROM node:20-slim AS frontend
# Uses a Node.js image to run npm/vite
# Outputs built HTML/JS/CSS to backend/static/

# Stage 2: Run the Python backend
FROM python:3.11-slim
# Uses a Python image
# Copies the built frontend from Stage 1
# Installs Python dependencies
# Runs uvicorn (the web server)
```

The two-stage approach keeps the final image smaller — the Node.js tools used to build the frontend aren't included in the final image, only the built output.

**Key Docker commands:**

| Command | What it does |
|---|---|
| `docker build -t mail-sherlock .` | Build the image from the Dockerfile |
| `docker run -d --name mail-sherlock ...` | Start a container from the image |
| `docker ps` | List running containers |
| `docker logs mail-sherlock` | View app logs |
| `docker restart mail-sherlock` | Restart the container |
| `docker stop mail-sherlock` | Stop the container |

**Flags explained:**
- `-d` = detached (runs in background, doesn't block your terminal)
- `--restart unless-stopped` = auto-restart if the server reboots or the app crashes
- `--env-file backend/.env` = load environment variables from the .env file
- `-p 8000:8000` = map port 8000 on the host to port 8000 in the container

---

## 6. Environment Variables (.env)

**What they are:** Configuration values your app reads at runtime, kept outside the source code.

**Why not hardcode them:**
- Credentials in source code get committed to GitHub and become public
- Different environments (local vs production) need different values
- Easy to rotate secrets without changing code

**What we set:**

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Connection string to MongoDB Atlas database |
| `GEMINI_API_KEY` | API key for Google Gemini AI |
| `GOOGLE_CREDENTIALS_JSON` | Google OAuth client credentials (for Gmail login) |
| `BACKEND_URL` | The app's public URL — used to construct OAuth redirect URIs |
| `DB_MAIL` | MongoDB database name |

**Important:** The `.env` file lives on the EC2 server only. It's gitignored so it never gets committed to GitHub.

---

## 7. nginx (Reverse Proxy)

**What it is:** A high-performance web server that sits in front of your app.

**Why we need it:**
- Your FastAPI app runs on port 8000, but websites use port 80 (HTTP) and 443 (HTTPS)
- nginx listens on 80/443 and forwards requests to port 8000
- nginx handles HTTPS termination (decrypts HTTPS, passes plain HTTP to your app)
- nginx can serve multiple apps on the same server on different domains

**What "reverse proxy" means:**
- A regular proxy forwards requests FROM clients TO the internet (like a VPN)
- A reverse proxy forwards requests FROM the internet TO your server — it's the front door

**Our nginx config:**
```nginx
server {
    listen 80;
    server_name mailsherlock.space;
    return 301 https://$host$request_uri;  # redirect all HTTP to HTTPS
}

server {
    listen 443 ssl;
    server_name mailsherlock.space;
    # SSL certificates from certbot

    location / {
        proxy_pass http://localhost:8000;  # forward to FastAPI
        proxy_set_header X-Forwarded-Proto $scheme;  # tell app it's HTTPS
    }
}
```

**Why `X-Forwarded-Proto` matters:** Without it, your app thinks it's receiving plain HTTP (because nginx→app is HTTP internally). If the app has any HTTP→HTTPS redirect logic, it causes an infinite redirect loop.

---

## 8. HTTPS with Let's Encrypt (certbot)

**What it is:** Free SSL/TLS certificates from Let's Encrypt, a non-profit CA (Certificate Authority).

**Why HTTPS:**
- Encrypts traffic between the browser and server
- Without it, anyone on the network can read the data (including Gmail OAuth tokens)
- Browsers show "Not Secure" warnings for HTTP sites
- Required for Google OAuth to work on production

**How certbot works:**
1. You run `certbot --nginx -d mailsherlock.space`
2. Certbot contacts Let's Encrypt and proves you control the domain (by placing a file on your server that Let's Encrypt fetches)
3. Let's Encrypt issues a certificate
4. Certbot automatically edits your nginx config to use it
5. Certbot sets up auto-renewal (certificates expire every 90 days)

---

## 9. Cloudflare

**What it is:** A CDN (Content Delivery Network) and security layer that sits between the internet and your server.

**Why your domain used it:** When you registered `mailsherlock.space`, the registrar pointed DNS through Cloudflare.

**What Cloudflare does:**
- Hides your real EC2 IP (DDoS protection)
- Caches static assets globally (faster loads)
- Free SSL between browser and Cloudflare

**The SSL mode problem we hit:**

```
Flexible mode (wrong):
Browser → HTTPS → Cloudflare → HTTP → nginx → 301 HTTPS redirect → loop ♾️

Full mode (correct):
Browser → HTTPS → Cloudflare → HTTPS → nginx → app ✓
```

- **Flexible:** Cloudflare connects to your origin over HTTP — causes a loop because nginx redirects HTTP to HTTPS
- **Full:** Cloudflare connects to your origin over HTTPS — works correctly
- **Full (Strict):** Same as Full but also validates the certificate is from a trusted CA — the most secure option

---

## 10. Google OAuth

**What it is:** A standard protocol that lets users log in with their Google account and grant your app access to their Gmail data.

**The flow:**
```
User clicks "Connect Gmail"
      ↓
App redirects to Google's OAuth page
      ↓
User logs in to Google and grants permission
      ↓
Google redirects back to your app at /auth/callback with an auth code
      ↓
Your app exchanges the code for an access token
      ↓
Your app uses the token to read Gmail via the Gmail API
```

**Why `BACKEND_URL` matters:** Your app constructs the redirect URI as `BACKEND_URL + /auth/callback`. Google only accepts redirects to URIs you've pre-registered in Google Cloud Console. If `BACKEND_URL` is wrong, OAuth fails.

**Test users:** Because `gmail.readonly` is a sensitive scope, Google requires verification (1–4 weeks) before any Google user can log in. In Testing mode, you bypass this by manually adding Gmail addresses — those users can log in immediately, everyone else gets a 403 error.

---

## 11. The Redirect Loop — What Happened & Why

This is worth understanding in detail since it's a common production issue.

**The chain of redirects:**
1. Browser requests `http://mailsherlock.space`
2. Cloudflare (Flexible mode) receives it over HTTPS, forwards to EC2 over **HTTP**
3. nginx receives HTTP on port 80, returns `301 → https://mailsherlock.space`
4. Cloudflare receives the redirect, follows it, again forwards to EC2 over **HTTP**
5. nginx sees HTTP again, returns `301` again → infinite loop

**The fix:** Cloudflare SSL mode → **Full** tells Cloudflare to connect to EC2 over HTTPS, so nginx's port 80 redirect is never triggered.

---

## Summary: What Each Tool Does

| Tool | Role |
|---|---|
| AWS EC2 | The physical server your app runs on |
| Ubuntu | The operating system on the server |
| Docker | Packages and runs your app in a container |
| nginx | Reverse proxy — handles ports 80/443, forwards to port 8000 |
| certbot | Gets and renews free HTTPS certificates from Let's Encrypt |
| Cloudflare | CDN + security layer in front of your server |
| MongoDB Atlas | Cloud-hosted database (not on EC2) |
| Google OAuth | Lets users log in with Gmail and grant email access |
| `.env` file | Stores secrets and config outside of source code |
| GitHub Actions | Runs CI checks and auto-deploys on push (CI/CD) |

---

## 12. Issues We Hit & How We Fixed Them

### SSH "bad permissions" on Windows
The `.pem` key file had permissions too open — other Windows users could read it. SSH refuses to use insecure keys.

**Fix:**
```powershell
icacls "C:\Users\trung\Downloads\mail-sherlock.pem" /inheritance:r /grant:r "trung:(R)"
```
On Git Bash, use forward slashes for the path:
```bash
ssh -i "/c/Users/trung/Downloads/mail-sherlock.pem" ubuntu@<IP>
```

---

### ERR_TOO_MANY_REDIRECTS (redirect loop)
**What happened:** Cloudflare was set to **Flexible SSL** mode, which connects to EC2 over HTTP. nginx redirects all HTTP to HTTPS. This created an infinite loop:
```
Browser → HTTPS → Cloudflare → HTTP → nginx → 301 HTTPS → Cloudflare → HTTP → loop
```

**Fix:** Cloudflare dashboard → SSL/TLS → change from **Flexible** to **Full**.

---

### Error 400: invalid_request — wrong redirect_uri
**What happened:** The app was using `BACKEND_URL=http://35.81.149.107:8000` (the old EC2 IP) to construct the OAuth redirect URI. Google rejected it because `https://mailsherlock.space/auth/callback` was registered but the app was sending `http://35.81.149.107:8000/auth/callback`.

**Root cause:** `docker restart` reloads the app process but does NOT reload the `--env-file`. The container kept the old environment variables.

**Fix:** Must fully stop, remove, and re-run the container to pick up new env vars:
```bash
docker stop mail-sherlock && docker rm mail-sherlock
docker run -d --name mail-sherlock --restart unless-stopped --env-file ~/mail-sherlock/backend/.env -p 8000:8000 mail-sherlock
```

**Lesson:** `docker restart` ≠ re-reading the env file. Always use `docker exec <container> env | grep <VAR>` to verify what the running container actually sees.

---

### .env file not saving correctly in nano
Pasting multi-line content into nano over SSH sometimes collapses lines or corrupts formatting.

**Fix:** Use a heredoc to write the file directly from the terminal — more reliable than nano for structured content:
```bash
cat > ~/mail-sherlock/backend/.env << 'EOF'
MONGODB_URI=...
DB_MAIL=mail_sherlock
...
EOF
```

**To verify the file has proper newlines** (each line ending with `$`):
```bash
cat -A ~/mail-sherlock/backend/.env
```
