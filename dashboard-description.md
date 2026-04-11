# Mail Sherlock — Dashboard Feature Description

## Table of Contents
1. [Top Navigation Bar](#1-top-navigation-bar)
2. [Header Row](#2-header-row)
3. [Left Sidebar](#3-left-sidebar)
   - [Menu Section](#31-menu-section)
   - [Labels Section](#32-labels-section)
   - [Accounts Section](#33-accounts-section)
4. [Main Chat Panel](#4-main-chat-panel)
   - [Filter Chips](#41-filter-chips)
   - [AI Welcome Message](#42-ai-welcome-message)
   - [Suggestion Pills](#43-suggestion-pills)
   - [Message Bubbles](#44-message-bubbles)
   - [Email Result Cards](#45-email-result-cards)
   - [Message Timestamp](#46-message-timestamp)
   - [Star / Bookmark](#47-star--bookmark)
5. [Input Bar](#5-input-bar)
6. [Footer Attribution Line](#6-footer-attribution-line)

---

## 1. Top Navigation Bar

### Logo + App Name (`mail-sherlock`)
Clicking the logo from any page returns the user to the Dashboard in its default state — fresh chat, no active filters.

### Navigation Tabs

| Tab | Function |
|---|---|
| **Dashboard** | Active by default. The main semantic search and AI chat interface where users find emails. |
| **Accounts** | Full account management page — add, remove, re-authenticate, and monitor sync status per Gmail account. |
| **Insights** | Visual stats page — email volume by label, most active senders, search history, attachment counts, and account breakdowns. |
| **Settings** | User preferences — sync behavior, search style, assistant behavior, label config, privacy controls, and appearance. |

### User Avatar (top right)
Displays the user's initials in a colored circle. Clicking opens a small dropdown with:
- Signed-in email address
- Link to Settings
- Sign out button

---

## 2. Header Row

### Greeting — `Good morning, thlinh03`
Dynamic time-based greeting that changes between morning / afternoon / evening. The name is pulled from the user's display name in Settings. Personalizes the experience and makes the app feel alive on every visit.

### Stats Line — `525 emails indexed · 1 account`
A real-time at-a-glance summary showing:
- **Emails indexed** — total emails stored across all connected accounts' local indexes. Updates after every sync.
- **Account count** — how many Gmail accounts are currently connected and active.

### `New conversation` Button — top right
Clears the current chat thread and resets the panel to the welcome message state. Does not affect accounts, indexes, or any saved data. Used when the user wants to start a completely fresh search session.

---

## 3. Left Sidebar

### 3.1 Menu Section

| Item | Function |
|---|---|
| **Search** | Opens the AI chat interface — the main dashboard view. Active state is highlighted with a filled purple background. |
| **All emails** | Switches to a browsable list of all indexed emails across every connected account, no query needed. |
| **Starred** | Filters the view to only show emails the user has starred in Gmail. |
| **Attachments** | Filters the view to only show emails that contain one or more file attachments. |

---

### 3.2 Labels Section

Smart labels that automatically classify emails by topic. The AI layer analyzes subject lines and snippets at index time and assigns each email to one or more categories.

#### Default Labels

| Label | Color | What It Catches |
|---|---|---|
| **Housing** | 🟣 Purple | Lease agreements, rent payments, landlord messages, utility bills |
| **Finance** | 🔵 Blue | Invoices, bank statements, payment confirmations, subscriptions |
| **Work** | 🟢 Green | Job offers, HR communications, workplace emails, meeting invites |
| **School** | 🟠 Orange | Assignment deadlines, grade notifications, course registration, university announcements |

Clicking any label filters the entire search context to only emails under that category.

#### Label Customization

Every label — including the 4 defaults — supports the following actions, accessible by hovering the label and clicking the `···` menu:

| Action | Behavior |
|---|---|
| **Rename** | Click the label name to edit it inline. Press Enter to save. Renaming a default label only changes the display name — its keyword rules stay intact. |
| **Change color** | Opens a small color picker popover with 9 preset swatches matching the design system. One click to apply. |
| **Add / remove keywords** | Keywords are the words that tell the AI what emails belong here. Shown as removable chips (e.g., `lease ×`, `rent ×`). Click `+ Add keyword` to type a new one. |
| **Hide from sidebar** | Toggles visibility. The label still exists and still classifies emails — it just doesn't appear in the sidebar. Re-enable it anytime from Settings. |
| **Delete** | Removes the label entirely. Default labels show a warning before deletion: *"This will remove your customizations. The default label can be restored in Settings."* |

#### Create New Label
A `+ New label` option at the bottom of the labels list opens a blank row with an auto-focused name input, a default gray color dot, and an empty keywords field. The user names it, picks a color, and adds keywords — then it immediately starts classifying emails and appears in the sidebar.

---

### 3.3 Accounts Section

#### Connected Account Rows
Each connected Gmail account appears as a row showing:
- **Status dot** — green = active and synced, yellow = sync in progress, red = needs re-login
- **Email address** — truncated with ellipsis if too long
- **Email count** — number of indexed emails for that account (e.g., `525`)

Clicking an account row filters all search results to that account only — same behavior as clicking the account filter chip in the main panel.

Hovering an account row reveals a `···` menu with:
- **Sync this account** — rebuilds the index for just this account
- **Fix connection** — shown when the token is expired, re-triggers Google sign-in
- **Disconnect** — removes the account, its token, and its local index with a confirmation dialog: *"This will remove [email] and delete its local search data. Your actual Gmail emails are not affected."*

#### `+ Add account` Button
Opens Google OAuth sign-in flow to connect an additional Gmail account. After authentication:
1. A new account row appears immediately with an `indexing...` spinner
2. Once indexing finishes, the spinner is replaced by the email count
3. A new filter chip for the account is added to the chat panel automatically

**Edge cases handled:**

| Situation | Behavior |
|---|---|
| Account already connected | Toast: *"This account is already connected."* OAuth flow does not start. |
| User cancels sign-in midway | No error shown, nothing changes. |
| Index build fails after auth | Account row shows a ⚠️ icon with a `Retry` link. |
| No accounts connected yet | The entire Accounts section is replaced with just the `+ Add account` button and helper text: *"Connect a Gmail account to get started."* |

#### `Sync emails` Button
Triggers a full re-fetch from Gmail and rebuilds the embedding index for **all** connected accounts simultaneously. Shows a progress spinner while running. The stats line in the header updates once sync completes.

---

## 4. Main Chat Panel

### 4.1 Filter Chips

A horizontal row of pill-shaped filters that scope what the search runs against. Sits above the chat thread and persists across the conversation.

| Chip | Behavior |
|---|---|
| **All accounts** | Default active state. Search runs across every connected account simultaneously. Filled/purple when active. |
| **[account email]** | One chip per connected account. Clicking it narrows the search to only that account's index. New chips are added automatically when a new account is connected. |
| **Has attachment** | Stacks on top of the account filter. Only returns emails that contain at least one file attachment. |
| **Unread only** | Stacks on top of the account filter. Only returns emails marked as unread in Gmail. |

> **Note:** Account chips are mutually exclusive — only one account at a time, or All accounts. `Has attachment` and `Unread only` can be combined with any account selection.

---

### 4.2 AI Welcome Message

The opening chat bubble from the assistant on every new conversation:

> *"Hi thlinh03! I'm your Smart Inbox assistant. Describe any email you're looking for and I'll find it across your connected accounts."*

This is rendered as an AI message bubble, establishing the conversational interface. It always appears at the top of every new conversation thread.

---

### 4.3 Suggestion Pills

Four quick-tap prompt buttons embedded inside the welcome bubble. Clicking any pill pre-fills and submits that query immediately:

| Pill | What it searches for |
|---|---|
| **Lease renewal** | Housing and lease-related emails |
| **Invoice / payment** | Billing and finance emails |
| **School deadline** | Academic deadline and assignment emails |
| **Job offer** | Recruiting and job offer emails |

After every AI response, a new set of context-aware suggestion pills is generated by Gemini based on what was just found, guiding the user toward natural follow-up searches.

---

### 4.4 Message Bubbles

The chat thread renders two types of bubbles:

**User bubble** (right-aligned):
- Shows the user's raw query text
- Timestamp displayed below

**AI bubble** (left-aligned):
- Shows the assistant's response text
- Embeds email result cards inline when emails are found
- Shows a follow-up clarifying question instead of results when the query is too vague
- Shows context-aware suggestion pills for follow-up searches
- Timestamp displayed below
- ⭐ Star icon to bookmark the response for later reference

---

### 4.5 Email Result Cards

Each matched email is rendered as a card inside the AI's response bubble, containing:

| Field | Description |
|---|---|
| **Sender** | Sender's name and email address |
| **Subject** | Full subject line of the email |
| **Date** | Date the email was received |
| **Snippet** | The most relevant excerpt from the email body |
| **Account badge** | Which Gmail account this email came from — critical for multi-account users |
| **Relevance score** | Subtle confidence indicator showing how well the email matches the query (e.g., 94% match) |
| **Open in Gmail** | Deep link that opens the full email thread directly in Gmail |

---

### 4.6 Message Timestamp

Shown below every bubble. Displays the time the message was sent within the current session (e.g., `12:21 AM`).

---

### 4.7 Star / Bookmark

Shown below AI response bubbles. Lets the user save a search result thread for later reference. Saved threads are accessible from a future "Saved searches" section.

---

## 5. Input Bar

### 🎤 Microphone Button (left)
Voice input. Records the user's spoken query, transcribes it to text, and places it in the input field. The user can review before submitting, or it auto-submits after a short pause.

### Text Input Field
The main query entry point.

**Placeholder text:** `Ask me to find an email, or ask a follow-up...`

Accepts three types of input:

| Input type | Example |
|---|---|
| **New search query** | *"find the email from my landlord about the broken heater"* |
| **Follow-up refinement** | *"only from last month"* or *"show me ones with attachments"* |
| **Clarification response** | Answering a follow-up question the AI asked, e.g., *"Do you remember roughly when this was sent?"* |

### ➤ Send Button (right)
Submits the current input to the search pipeline. Purple and active when the field has text, grayed out when empty. Also triggered by pressing `Enter`.

---

## 6. Footer Attribution Line

Displayed at the bottom of the chat panel:

> *"mail-sherlock searches as thlinh03@gmail.com · results ranked by semantic similarity"*

Updates dynamically based on the active account filter:

| Active filter | Footer text |
|---|---|
| All accounts | *"mail-sherlock searches across 2 accounts · results ranked by semantic similarity"* |
| Single account | *"mail-sherlock searches as thlinh03@gmail.com · results ranked by semantic similarity"* |

Reinforces the privacy-first message — users can see exactly what's being searched and that ranking happens locally on their machine.
