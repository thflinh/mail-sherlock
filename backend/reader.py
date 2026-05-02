"""Email reader utilities for mail-sherlock.

Handles fetching and sanitizing full email content for the in-app reading panel.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

# Optional dependencies — graceful fallback if not installed
try:
    import bleach
    _BLEACH = True
except ImportError:
    _BLEACH = False
    logger.warning("bleach not installed — HTML sanitization will strip all tags.")

try:
    import html2text as _h2t
    _HTML2TEXT = True
except ImportError:
    _HTML2TEXT = False
    logger.warning("html2text not installed — plain text extraction will use regex fallback.")


_ALLOWED_TAGS = [
    "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code",
    "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins",
    "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp",
    "small", "span", "strong", "sub", "sup", "table", "tbody",
    "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var",
]

_ALLOWED_ATTRS = {
    "a":   ["href", "title", "target", "rel"],
    "img": ["src", "alt", "width", "height"],
    "td":  ["colspan", "rowspan", "align"],
    "th":  ["colspan", "rowspan", "align"],
    "col": ["span"],
    "*":   ["class", "style"],
}

_ALLOWED_PROTOCOLS = ["http", "https", "mailto"]

# CSS properties that are safe to keep in inline styles
_SAFE_STYLE_RE = re.compile(
    r"(font-size|font-weight|font-style|color|background-color|"
    r"text-align|margin|padding|border|width|height|display)\s*:[^;\"']+",
    re.IGNORECASE,
)


def _clean_style(tag: str, name: str, value: str) -> str | bool:
    """bleach attribute cleaner — strips unsafe CSS, keeps safe properties."""
    if name == "style":
        safe = "; ".join(_SAFE_STYLE_RE.findall(value))
        return safe if safe else False
    return value


def sanitize_html(raw_html: str) -> str:
    """Strip dangerous HTML while preserving formatting.

    Removes: scripts, iframes, forms, event handlers, tracking pixels,
             external image src attributes (replaced with empty src).
    Preserves: bold, italic, links, tables, lists, headings.
    """
    if not raw_html:
        return ""

    # Remove tracking pixels and external images before bleach
    # (replace external img src with data URI placeholder)
    cleaned = re.sub(
        r'<img([^>]*)\ssrc=["\']https?://[^"\']+["\']([^>]*)>',
        r'<img\1 src="" alt="[image]"\2>',
        raw_html,
        flags=re.IGNORECASE,
    )
    # Remove style/link/script/iframe blocks entirely
    for tag in ("script", "style", "iframe", "form", "object", "embed", "base"):
        cleaned = re.sub(
            rf"<{tag}[^>]*>.*?</{tag}>",
            "",
            cleaned,
            flags=re.IGNORECASE | re.DOTALL,
        )

    if _BLEACH:
        cleaned = bleach.clean(
            cleaned,
            tags=_ALLOWED_TAGS,
            attributes=_ALLOWED_ATTRS,
            protocols=_ALLOWED_PROTOCOLS,
            strip=True,
            strip_comments=True,
        )
    else:
        # Fallback: strip all tags
        cleaned = re.sub(r"<[^>]+>", "", cleaned)

    return cleaned.strip()


def extract_plain_text(body_html: str) -> str:
    """Convert HTML to readable plain text.

    Preserves structure: headings become uppercase, lists stay as lists,
    links show URL in parentheses.
    """
    if not body_html:
        return ""
    if _HTML2TEXT:
        h = _h2t.HTML2Text()
        h.ignore_links = False
        h.ignore_images = True
        h.body_width = 0  # no line wrapping
        h.unicode_snob = True
        return h.handle(body_html).strip()
    # Regex fallback
    text = re.sub(r"<br\s*/?>", "\n", body_html, flags=re.IGNORECASE)
    text = re.sub(r"<p[^>]*>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</p>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


async def get_email_for_reader(
    email_id: str, db, session_id: str | None = None, body_override: str = ""
) -> dict | None:
    """Retrieve full email from MongoDB and return it ready for the reading panel.

    Returns subject, sender, date, bodyHtml (sanitized), bodyText, attachments,
    isUnread, smartLabels, threadId — or None if not found.
    """
    query: dict = {"id": email_id}
    if session_id:
        query["owner_session"] = session_id
    doc = await db["emails"].find_one(query, {"_id": 0})
    if not doc:
        return None

    raw_html = doc.get("bodyHtml") or ""
    body_text = body_override or doc.get("body") or ""

    # If bodyHtml is absent but body contains HTML, promote it
    if not raw_html and re.search(r"<(html|body|div|table|td|p|br)\b", body_text, re.IGNORECASE):
        raw_html = body_text
        body_text = ""

    safe_html = sanitize_html(raw_html) if raw_html else ""
    plain_text = body_text or (extract_plain_text(raw_html) if raw_html else "")

    return {
        "id":           doc.get("id"),
        "threadId":     doc.get("threadId"),
        "subject":      doc.get("subject", "(no subject)"),
        "sender":       doc.get("sender", ""),
        "date":         doc.get("date", ""),
        "bodyHtml":     safe_html,
        "bodyText":     plain_text,
        "snippet":      doc.get("snippet", ""),
        "isUnread":     doc.get("isUnread", False),
        "hasAttachment":doc.get("hasAttachment", False),
        "attachments":  doc.get("attachments", []),
        "smartLabels":  doc.get("smartLabels", []),
        "account":      doc.get("accountEmail", ""),
    }
