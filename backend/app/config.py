import os
from dotenv import load_dotenv

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
DATABASE_URL = os.getenv("DATABASE_URL")

# Discrete DB parameters as fallback for local docker-compose setup
DB_HOST = os.getenv("DATABASE_HOST", "localhost")
DB_PORT = os.getenv("DATABASE_PORT", "5433")  # mapped port in docker-compose is 5433
DB_USER = os.getenv("DATABASE_USER", "postgres")
DB_PASSWORD = os.getenv("DATABASE_PASSWORD", "postgres")
DB_NAME = os.getenv("DATABASE_NAME", "rag_db")

def get_connection_string() -> str:
    """Return the active connection string, falling back to discrete parameters if DATABASE_URL is not set."""
    if DATABASE_URL:
        # neon.tech urls use postgres://, psycopg requires postgresql://
        url = DATABASE_URL
        if url.startswith("postgres://"):
            url = "postgresql://" + url[len("postgres://"):]
        return url
    
    return f"postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
