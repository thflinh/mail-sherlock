import os

import certifi
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "")
DB_MAIL = (os.getenv("DB_MAIL", "mail_sherlock") or "mail_sherlock").strip()

client: AsyncIOMotorClient = None


def _mongo_client_kwargs() -> dict:
    kw: dict = {"serverSelectionTimeoutMS": 8000}
    uri = MONGODB_URI.lower()
    # Local mongodb:// has no TLS; skip TLS kwargs so we do not confuse the driver.
    uses_tls = "mongodb+srv://" in uri or "tls=true" in uri or "ssl=true" in uri
    if uses_tls:
        kw["tlsCAFile"] = certifi.where()
        # Dev-only: relax verification if Atlas handshakes still fail (not a fix for all TLS_ALERT errors).
        if os.getenv("MONGODB_TLS_INSECURE", "").strip().lower() in ("1", "true", "yes"):
            kw["tlsInsecure"] = True
    return kw


async def connect_db():
    global client
    client = AsyncIOMotorClient(MONGODB_URI, **_mongo_client_kwargs())


async def close_db():
    global client
    if client:
        client.close()


def get_db():
    return client[DB_MAIL]
