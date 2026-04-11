# Mail Sherlock — Accounts Page Feature Description

## Table of Contents
1. [Page Overview](#1-page-overview)
2. [Page Header](#2-page-header)
3. [Add Account Banner (empty state)](#3-add-account-banner-empty-state)
4. [Connected Accounts List](#4-connected-accounts-list)
   - [Account Card](#41-account-card)
   - [Account Status Indicators](#42-account-status-indicators)
   - [Account Actions Menu](#43-account-actions-menu)
5. [Add Account Button](#5-add-account-button)
6. [OAuth Sign-in Flow](#6-oauth-sign-in-flow)
7. [Indexing Progress](#7-indexing-progress)
8. [Bulk Actions Bar](#8-bulk-actions-bar)
9. [Edge Cases](#9-edge-cases)

---

## 1. Page Overview

The Accounts page is the central hub for managing every Gmail account connected to Mail Sherlock. Users can add new accounts, monitor sync status, fix broken connections, reindex individual accounts, and disconnect accounts they no longer want to search. All changes made here are immediately reflected in the Dashboard sidebar and filter chips.

---

## 2. Page Header

### Title — `Connected Accounts`
Static page title. Displayed at the top of the content area below the navigation bar.

### Subtitle — `Manage the Gmail accounts Mail Sherlock searches across`
One-line description that sets context for new users landing on this page for the first time.

### Summary stats bar
A row of three stat chips below the subtitle:

| Stat | Description |
|---|---|
| **Total accounts** | Number of Gmail accounts currently connected (e.g., `2 accounts`) |
| **Total emails indexed** | Sum of all indexed emails across every account (e.g., `835 emails indexed`) |
| **Last synced** | Timestamp of the most recent sync across any account (e.g., `Last synced 2 hours ago`) |

---

## 3. Add Account Banner (Empty State)

Shown when no Gmail accounts are connected yet — replaces the account list entirely.

### Illustration
A simple centered illustration (envelope + plus icon) to visually communicate the empty state.

### Heading — `No accounts connected`
Clear, direct empty state heading.

### Body text
> *"Connect your Gmail accounts to start searching your emails with AI. Your emails are indexed locally — nothing is uploaded to any server."*

Reinforces the privacy-first value proposition at the moment of first setup.

### `+ Connect your first Gmail account` button
Large, centered, filled purple button. Triggers the OAuth sign-in flow. This is the only CTA on the empty state — no other distractions.

---

## 4. Connected Accounts List

When one or more accounts are connected, the page displays a vertical list of account cards — one card per Gmail account.

### 4.1 Account Card

Each card displays the following information:

| Field | Description |
|---|---|
| **Avatar** | Circle with the account's initials and a background color auto-assigned per account (e.g., purple for the first, blue for the second) |
| **Email address** | Full Gmail address (e.g., `thlinh03@gmail.com`) |
| **Display name** | The name associated with the Google account (e.g., `Thinh`) |
| **Status badge** | Color-coded pill showing the current connection state (see Section 4.2) |
| **Emails indexed** | Count of emails in this account's local index (e.g., `525 emails indexed`) |
| **Last synced** | Relative timestamp of the last successful index build (e.g., `Synced 2 hours ago`) |
| **Storage used** | Approximate size of the local index files for this account (e.g., `~14 MB local storage`) |
| **Actions menu** `···` | Hover or click to reveal per-account actions (see Section 4.3) |

---

### 4.2 Account Status Indicators

| Status | Color | Meaning |
|---|---|---|
| **Active** | 🟢 Green | Connected, token valid, index up to date |
| **Syncing** | 🟡 Yellow (animated) | Currently fetching emails or rebuilding index |
| **Needs re-login** | 🔴 Red | OAuth token expired — user must sign in again |
| **Index outdated** | 🔵 Blue | Connected and valid, but index hasn't been rebuilt in over 24 hours |
| **Index failed** | 🔴 Red | Last index build encountered an error — shows a `Retry` link inline |

---

### 4.3 Account Actions Menu

Accessible via the `···` button on each account card. Contains the following actions:

| Action | Behavior |
|---|---|
| **Sync this account** | Rebuilds the embedding index for this account only. Shows a progress spinner on the card while running. Maps to `POST /reindex` with the specific account email. |
| **Fix connection** | Visible only when status is `Needs re-login`. Re-triggers the Google OAuth sign-in flow for this account specifically, without affecting other accounts. |
| **View indexed emails** | Opens a filtered view of All Emails scoped to this account — lets the user browse what has been indexed. |
| **Disconnect** | Removes the account from Mail Sherlock. Opens a confirmation dialog: *"This will remove [email] and delete its local search data. Your actual Gmail emails are not affected."* On confirm: deletes the token from `tokens.json`, wipes `indexes/{email}.pt` and `indexes/{email}.json`, removes the account row and its filter chip from the Dashboard. |

---

## 5. Add Account Button

A full-width outlined button pinned below the last account card:

```
[ + Add another account ]
```

- Style: outlined, purple border and text — visually secondary to the per-card sync actions
- Clicking triggers the Google OAuth consent flow to connect a new Gmail account
- If the user is already at a reasonable account limit (e.g., 5 accounts), the button is replaced with a soft notice: *"You've connected 5 accounts. Remove one to add another."*

---

## 6. OAuth Sign-in Flow

When the user clicks `+ Add account` or `+ Add another account`:

**Step 1 — Redirect**
The app calls `GET /connect` on the backend, which redirects the browser to the Google OAuth consent screen.

**Step 2 — Google sign-in**
The user selects or signs into a Google account and grants Mail Sherlock read access to Gmail.

**Step 3 — Callback**
Google redirects to `GET /oauth/callback`. The backend:
- Exchanges the authorization code for an access + refresh token
- Saves the token to `tokens.json` keyed by the account's email address
- Immediately triggers index building for the new account

**Step 4 — Account appears**
The new account card appears on the Accounts page with status `Syncing` and an indexing progress indicator (see Section 7).

**Step 5 — Index complete**
Status updates to `Active`, email count is populated, and the account's filter chip appears in the Dashboard.

---

## 7. Indexing Progress

When an account is building its index for the first time, or during a manual reindex, the account card shows an expanded progress section:

| Element | Description |
|---|---|
| **Progress bar** | Animated fill bar showing percentage complete (e.g., `247 / 525 emails processed`) |
| **Status text** | Dynamic label: `Fetching emails...` → `Building search index...` → `Finishing up...` |
| **Cancel button** | Stops the index build mid-way. The account remains connected but will have an incomplete or empty index until the next sync. |

If the user navigates away during indexing, the process continues in the background. A subtle banner at the top of the Dashboard notifies them when it completes:
> *"thlinh03@gmail.com finished indexing — 525 emails ready to search."*

---

## 8. Bulk Actions Bar

Appears above the account list when two or more accounts are connected. Provides actions that apply to all accounts at once:

| Action | Behavior |
|---|---|
| **Sync all accounts** | Triggers `POST /reindex` for every connected account simultaneously. Same as clicking `Sync emails` in the Dashboard sidebar. |
| **Refresh all connections** | Re-validates OAuth tokens for all accounts. Prompts re-login only for accounts where the token has expired. |

---

## 9. Edge Cases

| Situation | Behavior |
|---|---|
| User tries to add an account already connected | Toast notification: *"This account is already connected."* OAuth flow does not start. |
| User cancels Google sign-in midway | No error shown, no changes made. The Accounts page stays as-is. |
| Index build fails after successful auth | Account card shows status `Index failed` with a ⚠️ icon and a `Retry` link that re-triggers indexing only (no re-auth needed). |
| Token expires while the app is open | The account card status updates to `Needs re-login` in real time. A non-blocking banner appears: *"[email] needs to be reconnected. Fix connection."* |
| User disconnects the only connected account | The page transitions back to the empty state (Section 3). The Dashboard also resets to its no-account state. |
| Network is offline during sync | Sync fails gracefully. Toast: *"Could not reach Gmail. Check your connection and try again."* Index is not corrupted — the previous version remains intact. |
