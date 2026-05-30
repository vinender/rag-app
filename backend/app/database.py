import logging
from contextlib import contextmanager
from psycopg_pool import ConnectionPool
from app.config import get_connection_string

logger = logging.getLogger("rag-app")
logging.basicConfig(level=logging.INFO)

# Global pool instance
pool = None

def init_pool():
    global pool
    conn_str = get_connection_string()
    logger.info(f"Initializing database pool with connection string: {conn_str.split('@')[-1]}")
    # Initialize connection pool
    pool = ConnectionPool(
        conninfo=conn_str,
        min_size=1,
        max_size=10,
        open=True
    )

def close_pool():
    global pool
    if pool:
        logger.info("Closing database pool...")
        pool.close()
        pool = None

@contextmanager
def get_db_connection():
    global pool
    if pool is None:
        init_pool()
    with pool.connection() as conn:
        yield conn

def init_db():
    """Ensure pgvector extension, advanced schema, and full-text search indexes exist."""
    logger.info("Initializing database schema...")
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            # Enable pgvector extension
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
            
            # Create main document chunk table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS document_chunk (
                    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                    filename text NOT NULL DEFAULT '',
                    content text NOT NULL,
                    embedding vector(1536) NOT NULL,
                    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
                    created_at timestamptz NOT NULL DEFAULT now()
                )
            """)
            
            # Check if metadata column exists (migration for older schemas)
            cur.execute("""
                SELECT column_name FROM information_schema.columns 
                WHERE table_name = 'document_chunk' AND column_name = 'metadata'
            """)
            if not cur.fetchone():
                cur.execute("ALTER TABLE document_chunk ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb")
                conn.commit()

            # Check if tsv (full-text search vector) column exists, if not create it
            cur.execute("""
                SELECT column_name FROM information_schema.columns 
                WHERE table_name = 'document_chunk' AND column_name = 'tsv'
            """)
            if not cur.fetchone():
                logger.info("Adding generated column 'tsv' for Full-Text Search...")
                cur.execute("""
                    ALTER TABLE document_chunk 
                    ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
                """)
                conn.commit()
            
            # Create GIN index for lexical search
            cur.execute("CREATE INDEX IF NOT EXISTS document_chunk_tsv_idx ON document_chunk USING gin(tsv)")
            
            # Create GIN index for metadata filtering
            cur.execute("CREATE INDEX IF NOT EXISTS document_chunk_metadata_idx ON document_chunk USING gin(metadata)")
            
            # Commit all schema changes
            conn.commit()
    logger.info("Database schema initialized successfully.")
