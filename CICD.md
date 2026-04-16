# CI/CD Plan

## Current State

You already have `.github/workflows/ci.yml` with two jobs:
- `lint` — runs `ruff check` on the backend
- `health-check` — parses Python files for syntax errors

This is a starting point. The plan below extends it into a full CI/CD pipeline.

---

## Target Pipeline

```
Push to any branch
      ↓
  CI Pipeline (GitHub Actions)
  ├── Lint (Python + TypeScript)
  ├── Type check (TypeScript)
  └── Build frontend (npm run build)
      ↓ (only on push to main)
  CD Pipeline
  └── SSH into EC2 → git pull → docker build → docker restart
```

---

## What You Need

### GitHub Secrets (set in repo → Settings → Secrets and variables → Actions)

| Secret        | How to get it                                                                |
| ------------- | ---------------------------------------------------------------------------- |
| `EC2_HOST`    | Your EC2 public IP address                                                   |
| `EC2_USER`    | `ubuntu` (default for Ubuntu AMI)                                            |
| `EC2_SSH_KEY` | Contents of your `.pem` key file (the whole thing including `-----BEGIN...`) |

That's it. The CD job SSHs into your EC2 instance, pulls the latest code, rebuilds, and restarts the container.

### Tools to install locally (optional, for running checks before pushing)

```bash
pip install ruff
npm install -g typescript
```

---

## Implementation Steps

### Step 1 — Add GitHub Secrets (10 min)

1. GitHub → your repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** and add:
   - `EC2_HOST` — your EC2 public IP
   - `EC2_USER` — `ubuntu`
   - `EC2_SSH_KEY` — paste the full contents of your `.pem` key file

---

### Step 2 — Upgrade the CI workflow (1–2 hrs)

Replace `.github/workflows/ci.yml` with the full version below.

**What gets added vs current:**
- TypeScript type check on the frontend
- Frontend build check (catches broken imports, missing env vars)
- Separates jobs cleanly so failures are easy to read

```yaml
name: CI

on:
  push:
    branches: ["**"]
  pull_request:
    branches: [main]

jobs:
  lint-backend:
    name: Lint — Python (ruff)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install ruff
      - run: ruff check backend/

  typecheck-frontend:
    name: Type check — TypeScript
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: web/package-lock.json
      - run: npm ci
        working-directory: web
      - run: npx tsc --noEmit
        working-directory: web

  build-frontend:
    name: Build — React (Vite)
    runs-on: ubuntu-latest
    needs: typecheck-frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: web/package-lock.json
      - run: npm ci
        working-directory: web
      - run: npm run build
        working-directory: web

  syntax-check-backend:
    name: Syntax check — Python
    runs-on: ubuntu-latest
    needs: lint-backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install fastapi pydantic python-dotenv
      - name: Parse all backend files
        working-directory: backend
        run: |
          python - <<'EOF'
          import ast
          for f in ["main.py", "db.py", "embeddings.py", "agent_search.py", "agent.py"]:
              with open(f) as fh:
                  ast.parse(fh.read())
              print(f"  ✓ {f}")
          print("All files parse OK")
          EOF
```

---

### Step 3 — Add CD job (30 min)

Add a `deploy` job to the same workflow that runs only on push to `main`, after all CI jobs pass.

**Requires:** `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` secrets set in GitHub.

```yaml
  deploy:
    name: Deploy — AWS EC2
    runs-on: ubuntu-latest
    needs: [lint-backend, typecheck-frontend, build-frontend, syntax-check-backend]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ${{ secrets.EC2_USER }}
          key: ${{ secrets.EC2_SSH_KEY }}
          script: |
            cd mail-sherlock
            git pull origin main
            docker build -t mail-sherlock .
            docker stop mail-sherlock || true
            docker rm mail-sherlock || true
            docker run -d \
              --name mail-sherlock \
              --restart unless-stopped \
              --env-file backend/.env \
              -p 8000:8000 \
              mail-sherlock
```

The `appleboy/ssh-action` handles the SSH connection. The script runs on your EC2 instance — pulls latest code, rebuilds the image, and restarts the container.

---

### Step 4 — Add branch protection (15 min)

Enforce CI passes before merging to `main`.

1. GitHub → repo → **Settings** → **Branches**
2. Add rule for `main`
3. Check **Require status checks to pass before merging**
4. Select: `lint-backend`, `typecheck-frontend`, `build-frontend`, `syntax-check-backend`

---

## Time Summary

| Step      | What                                         | Time         |
| --------- | -------------------------------------------- | ------------ |
| 1         | Add GitHub secrets (EC2 host, user, SSH key) | 10 min       |
| 2         | Upgrade CI workflow                          | 1–2 hrs      |
| 3         | Add CD deploy job via SSH                    | 30 min       |
| 4         | Branch protection rules                      | 15 min       |
| **Total** |                                              | **~2–3 hrs** |

---

## Full Pipeline Flow (after all steps)

```
Developer pushes code
        ↓
GitHub Actions triggers
        ├── lint-backend        (ruff)
        ├── typecheck-frontend  (tsc)
        ├── build-frontend      (vite build)
        └── syntax-check-backend
              ↓ (all pass + branch is main)
        deploy
        └── SSH → EC2 → git pull → docker build → docker restart → live
```

---

## Future Improvements

### Short term
- **Add pytest** — write unit tests for key backend functions (query parsing, email formatting). Even 5–10 tests makes CI much more meaningful.
- **Add ESLint** — catch React/TypeScript code quality issues beyond type errors.
- **Docker build check in CI** — run `docker build` in the workflow to catch image build failures before they reach EC2.
- **Smoke test after deploy** — after the container restarts, hit `/ready` and assert HTTP 200. Fails the pipeline if the deployed app is broken.

### Medium term
- **Staging environment** — a second EC2 instance on a `staging` branch. Push to `staging` → deploy to staging. Push to `main` → deploy to production. Test before going live.
- **Dependabot** — auto-PRs for dependency updates (Python + npm). Add `.github/dependabot.yml`.
- **Use an Elastic IP** — your EC2 public IP changes if the instance is stopped/started. An Elastic IP keeps it fixed. Free as long as the instance is running.

### Long term
- **Performance tests** — benchmark AI query response time. Fail CI if p95 latency regresses beyond a threshold.
- **Secret scanning** — add `trufflesecurity/trufflehog` action to block commits with leaked API keys.
- **Docker image registry** — push built image to ECR (AWS container registry) and pull on EC2 instead of rebuilding on the server. Faster deploys.
