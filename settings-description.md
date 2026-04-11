# Mail Sherlock — Settings Page Feature Description

## Table of Contents
1. [Page Overview](#1-page-overview)
2. [Page Header](#2-page-header)
3. [Profile](#3-profile)
4. [Connected Accounts](#4-connected-accounts)
5. [Email Sync](#5-email-sync)
6. [Search Behavior](#6-search-behavior)
7. [Assistant Behavior](#7-assistant-behavior)
8. [Labels & Organization](#8-labels--organization)
9. [Privacy](#9-privacy)
10. [Appearance](#10-appearance)
11. [Notifications](#11-notifications)
12. [Help & About](#12-help--about)

---

## 1. Page Overview

The Settings page is where users control how Mail Sherlock looks, behaves, and handles their data. Every option is written in plain language — no technical jargon, no file paths, no model names. The page is organized into clearly labeled sections accessible via a left-side settings nav or by scrolling. Changes are saved automatically unless otherwise noted.

---

## 2. Page Header

### Title — `Settings`
Static page title at the top of the content area.

### Subtitle — `Customize how Mail Sherlock works for you`
One-line description.

### Left-side settings navigation
A vertical nav list linking to each section on the page:
- Profile
- Connected Accounts
- Email Sync
- Search Behavior
- Assistant Behavior
- Labels & Organization
- Privacy
- Appearance
- Notifications
- Help & About

Active section is highlighted as the user scrolls.

---

## 3. Profile

### Display name
- Editable text input showing the user's current display name (e.g., `thlinh03`)
- This name is used in the Dashboard greeting: *"Good morning, thlinh03"*
- Click to edit inline, press Enter or click away to save

### Avatar
- Displays the user's current initials in a colored circle
- `Change photo` link below — lets the user upload a profile image (jpg/png, max 2MB)
- `Remove photo` link — reverts to initials

### Sign out
- Red outlined button: `Sign out`
- Confirmation dialog: *"You'll be signed out of Mail Sherlock. Your local email data and indexes will remain on this device."*
- Ends the session and returns to the login/connect screen

---

## 4. Connected Accounts

A condensed view of connected accounts with quick-access management. Full account management is on the dedicated Accounts page.

### Account list
Each account shown as a compact row:
- Status dot (green / yellow / red)
- Email address
- `Fix connection` link — shown only when token is expired
- `Disconnect` link — removes the account with a confirmation dialog

### `+ Add another account` button
Outlined button. Triggers Google OAuth flow to connect a new Gmail account. On success, the new account appears in the list immediately.

### `Manage all accounts →` link
Navigates to the full Accounts page for detailed per-account controls.

---

## 5. Email Sync

Controls how and when Mail Sherlock fetches new emails and updates its local search index.

### Auto-sync
- **Toggle** — *"Keep my search index up to date automatically"*
- ON by default
- When OFF, the index only updates when the user manually clicks Sync

### Sync frequency
- **Dropdown** — visible only when Auto-sync is ON
- Options: *Every hour / Every 6 hours / Once a day / Only when I click Sync*
- Default: Every 6 hours

### How far back to search
- **Dropdown** — *"Include emails going back..."*
- Options: *Last 3 months / Last 6 months / Last year / All time*
- Default: Last 6 months
- Changing this setting prompts: *"This will rebuild your index. It may take a few minutes."* with a Confirm button

### Sync now
- **Button** — `Sync all accounts now`
- Manually triggers a full re-fetch and index rebuild for all connected accounts
- Shows a progress indicator inline while running

### Last synced
- Per-account timestamp displayed below the Sync now button
- Example: *"thlinh03@gmail.com — last synced 2 hours ago"*

---

## 6. Search Behavior

Controls how Mail Sherlock interprets queries and returns results.

### Search style
- **Radio button group** — two options presented as visual cards:

  | Option | Description |
  |---|---|
  | 🧠 **Smart search** *(recommended)* | Understands meaning and intent — finds emails even when you don't remember exact words. Best for natural language queries like *"the lease renewal from my landlord."* |
  | 🔤 **Keyword search** | Matches exact words only. Faster, but won't find an email about "rent" if you search "housing payment." |

- Default: Smart search

### Number of results to show
- **Dropdown** — *"Show me up to..."*
- Options: `3 results / 5 results / 10 results / 20 results`
- Default: 5 results

### Ask follow-up questions
- **Toggle** — *"When my search is vague, ask me a clarifying question before searching"*
- ON by default
- When OFF, the assistant always searches immediately, even on ambiguous queries

### Search all accounts by default
- **Toggle** — *"Search across all my connected accounts at the same time"*
- ON by default
- When OFF, the search defaults to the first connected account only

---

## 7. Assistant Behavior

Controls the personality and response style of the AI assistant.

### Assistant name
- **Text input** — *"What should I call your assistant?"*
- Default: `Sherlock`
- This name appears in the welcome message: *"Hi! I'm Sherlock, your Smart Inbox assistant."*

### Reply style
- **Dropdown** — *"How should the assistant respond?"*

  | Option | Description |
  |---|---|
  | **Concise** | Just shows result cards with minimal explanation |
  | **Conversational** *(default)* | Briefly explains what it found before showing results |
  | **Detailed** | Provides full context for each result — why it matched, what's in the email |

### Language
- **Dropdown** — *"Assistant replies in..."*
- Options: English / Spanish / Vietnamese / French / Auto-detect
- Default: Auto-detect (matches the language of the user's query)

### Show search suggestions
- **Toggle** — *"Show me helpful follow-up suggestions after each search"*
- ON by default
- Controls whether suggestion pills appear below AI responses

---

## 8. Labels & Organization

Full label management. See also: the inline label customization available directly from the Dashboard sidebar via the `···` hover menu.

### Auto-label toggle
- **Toggle** — *"Automatically organize my emails into categories"*
- ON by default
- When OFF, no labels are assigned to emails and the Labels section disappears from the Dashboard sidebar

### Label list
A vertical list of all labels — both default and custom. Each row contains:

| Element | Description |
|---|---|
| **Drag handle** `⠿` | Drag to reorder labels in the sidebar |
| **Color dot** | Clickable — opens a color picker popover with 9 preset swatches |
| **Label name** | Click to rename inline. Press Enter to save. Empty name reverts to previous. |
| **Keyword chips** | Shows current classification keywords (e.g., `lease ×`, `rent ×`). Click `+ Add keyword` to add, `×` to remove. |
| **Visible toggle** | Eye icon — hides the label from the sidebar without deleting it |
| **Delete button** `🗑` | Disabled for default labels unless user has customized them. Confirmation dialog required. |

#### Default label behavior
Default labels (Housing, Finance, Work, School) cannot be deleted outright. Instead, their delete button shows: *"Reset to default — this will remove your customizations."* Confirming restores the original name, color, and keywords.

### Create new label
A `+ Create new label` button at the bottom of the label list. Clicking inserts a new blank row:
- Auto-focused name input with placeholder *"Label name"*
- Default gray color dot
- Empty keywords field
- User fills in name + keywords → label is immediately active and starts classifying emails

### Empty keywords warning
If a label has no keywords, a subtle warning appears on its row:
> ⚠️ *"No keywords — this label won't classify any emails. Add at least one keyword."*

---

## 9. Privacy

The most important section for communicating Mail Sherlock's privacy-first positioning. Every setting is written to be transparent and reassuring.

### How Mail Sherlock handles your data
A permanent info card at the top of the section — not a toggle, always visible:

> *"Your emails are read from Gmail and indexed only on your own computer. Mail Sherlock never uploads your email content to any external server."*

### Use AI to improve search results
- **Toggle** — *"Send brief email summaries to Google's AI to rank results more accurately"*
- ON by default
- When OFF: search results still work fully using local semantic matching — Gemini reranking is simply skipped. Results may be slightly less precise but everything stays 100% local.
- Helper text below toggle: *"Turning this off keeps all processing entirely on your device."*

### Delete all my search data
- **Button** — red outlined: `Delete all search data`
- Confirmation dialog: *"This will delete all locally stored email indexes across all accounts. Your actual Gmail emails are not affected and can be re-indexed at any time."*
- Two-step confirm: user must type `DELETE` or click a second confirmation button to proceed
- On confirm: wipes all `indexes/*.pt` and `indexes/*.json` files, resets email counts to 0

### Download my data
- **Button** — `Download my index data`
- Exports all indexed email metadata (subject, sender, date, labels, snippet) as a `.json` file
- Does not export full email body content — only the metadata stored in the local index
- File is named: `mailsherlock-export-[date].json`

### Revoke all Gmail access
- **Button** — red outlined: `Revoke Gmail access`
- Confirmation dialog: *"This will sign Mail Sherlock out of all Google accounts, delete all tokens, and remove all local indexes. This cannot be undone."*
- On confirm: calls Google's OAuth revocation endpoint for each account, clears `tokens.json`, wipes all indexes, redirects to the empty/onboarding state

---

## 10. Appearance

Controls the visual presentation of the app.

### Theme
- **Radio group** with visual previews:
  - ☀️ Light *(default)*
  - 🌙 Dark
  - 💻 Follow system

### Text size
- **Radio group**: Small / Medium *(default)* / Large
- Affects all body text and result card content across the app

### Compact mode
- **Toggle** — *"Show more content on screen with less spacing"*
- OFF by default
- When ON: reduces padding in the sidebar, chat bubbles, and result cards

### Accent color
- **Color swatch picker** — 6 preset options:
  - 🟣 Purple `#9B72CF` *(default)*
  - 🔵 Blue `#185FA5`
  - 🩷 Pink `#F0C4DC`
  - 🟢 Teal `#0D9488`
  - 🟠 Orange `#854F0B`
  - 🩶 Slate `#64748B`
- Changing the accent color updates all active states, buttons, and highlights across the app

---

## 11. Notifications

Controls push notifications delivered via the Chrome extension. This section is only shown when the Mail Sherlock Chrome extension is installed and active.

### New email alerts
- **Toggle** — *"Notify me when a new email matches one of my recent searches"*
- OFF by default
- When ON: the extension's background service worker monitors incoming emails and sends a Chrome notification when a match is detected

### Sync complete notification
- **Toggle** — *"Let me know when Mail Sherlock finishes updating my email index"*
- OFF by default
- When ON: a Chrome notification appears once a sync or reindex operation finishes

### Extension badge count
- **Toggle** — *"Show unread email count on the Mail Sherlock icon in my browser toolbar"*
- ON by default
- Displays a numeric badge on the extension icon in the Chrome toolbar reflecting total unread emails across all connected accounts

---

## 12. Help & About

### App version
- Displayed as a read-only label: `Mail Sherlock v1.0.0`

### How it works
- A collapsible info card with a plain-English explanation:
  > *"Mail Sherlock connects to your Gmail, reads your emails, and builds a private search index stored only on your computer. When you search, it uses AI to understand what you mean — not just the exact words you typed. Your emails never leave your device."*

### Send feedback
- A short textarea input + `Send` button
- Submits the message as a GitHub issue or email to the project maintainers
- Placeholder: *"Tell us what's working, what's not, or what you'd like to see"*

### Report a problem
- Link to the project's GitHub Issues page

### Reset all settings
- **Button** — outlined: `Reset to defaults`
- Resets every setting on this page to its factory default value
- Does **not** affect connected accounts, email indexes, or label data
- Confirmation dialog: *"This will reset all your preferences to their default values. Your accounts and email data will not be affected."*

### Open source notice
- A small line of text at the bottom of the section:
  > *"Mail Sherlock is a CS4800 class project. Built with FastAPI, React, and sentence-transformers."*
