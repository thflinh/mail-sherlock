import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb+srv://ptlinhuni_db_user:mailsherlock@mail-db.degx8dt.mongodb.net/?appName=mail-db")
DB_MAIL = os.getenv("DB_MAIL", "mail_sherlock")

client: AsyncIOMotorClient = None


async def connect_db():
    global client
    client = AsyncIOMotorClient(MONGODB_URI)


async def close_db():
    global client
    if client:
        client.close()


def get_db():
    return client[DB_MAIL]
