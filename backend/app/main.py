import logging
from fastapi import FastAPI, UploadFile, File, HTTPException, Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import pgvector.psycopg

from app.database import init_pool, close_pool, init_db, get_db_connection
from app.document_processor import process_pdf_pages
from app.rag_pipeline import embed_text, get_openai_client, run_rag_query
from app.evaluator import evaluate_rag_response

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("rag-app")

app = FastAPI(
    title="Advanced RAG API",
    description="Python FastAPI backend for Advanced RAG with Hybrid Search, LLM Reranking, Metadata Filtering, and observability.",
    version="1.0.0"
)

# Enable CORS for frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # allow all origins in development, can be restricted in config
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Lifecycle Event Handlers
@app.on_event("startup")
async def startup_event():
    logger.info("Starting up FastAPI server...")
    init_pool()
    init_db()

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down FastAPI server...")
    close_pool()

# Pydantic Schemas
class AskRequest(BaseModel):
    question: str = Field(..., max_length=2000)
    history: List[Dict[str, str]] = Field(default_factory=list)
    filters: Optional[Dict[str, Any]] = None

class SourceResponse(BaseModel):
    filename: str
    snippet: str
    chapter: str
    page: int
    distance: float

class EvaluationResponse(BaseModel):
    faithfulness: float
    answer_relevance: float
    context_precision: float
    context_recall: float
    reasonings: Dict[str, str]

class AskResponse(BaseModel):
    answer: str
    sources: List[SourceResponse]
    evaluation: EvaluationResponse

class DocumentItem(BaseModel):
    filename: str
    chunk_count: int
    page_count: int
    created_at: str

# API Routes
@app.get("/api/health")
def health_check():
    """Verify backend and database connection health."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
        return {"status": "ok", "database": "connected"}
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Database connection failed: {str(e)}")

@app.get("/api/documents", response_model=List[DocumentItem])
def list_documents():
    """Get a list of all indexed PDF documents, chunk counts, page counts, and upload timestamps."""
    documents = []
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT 
                        filename,
                        COUNT(*) as chunk_count,
                        MAX((metadata->>'page')::int) as page_count,
                        TO_CHAR(MIN(created_at), 'YYYY-MM-DD HH24:MI:SS') as created_at
                    FROM document_chunk
                    GROUP BY filename
                    ORDER BY MIN(created_at) DESC
                """)
                for row in cur.fetchall():
                    documents.append({
                        "filename": row[0],
                        "chunk_count": row[1],
                        "page_count": row[2] or 1,
                        "created_at": row[3]
                    })
        return documents
    except Exception as e:
        logger.error(f"Failed to list documents: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to retrieve documents: {str(e)}")

@app.post("/api/documents/upload")
async def upload_document(file: UploadFile = File(...)):
    """Upload and index a PDF file: extracts text, chunks it, generates embeddings, and saves it with metadata."""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are allowed.")
    
    try:
        file_bytes = await file.read()
        logger.info(f"Received file: {file.filename} ({len(file_bytes)} bytes)")
        
        # 1. Parse PDF and extract page-by-page text & chapters (with OCR fallback)
        chunks = process_pdf_pages(file_bytes, file.filename)
        
        if not chunks:
            raise HTTPException(status_code=400, detail="No readable text or images could be extracted from this PDF.")
            
        client = get_openai_client()
        
        # 2. Insert chunks with embeddings in a single transaction
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                # First delete any existing chunks of the same file to prevent duplicates
                cur.execute("DELETE FROM document_chunk WHERE filename = %s", (file.filename,))
                
                logger.info(f"Generating embeddings and storing {len(chunks)} chunks...")
                for idx, chunk in enumerate(chunks):
                    content = chunk["content"]
                    metadata = chunk["metadata"]
                    
                    # Generate embedding
                    embedding = await embed_text(client, content)
                    
                    # Insert record (binding pgvector natively)
                    cur.execute(
                        "INSERT INTO document_chunk (filename, content, embedding, metadata) VALUES (%s, %s, %s::vector, %s)",
                        (file.filename, content, str(embedding), json.dumps(metadata))
                    )
                    
                conn.commit()
                
        logger.info(f"Successfully uploaded and indexed '{file.filename}' with {len(chunks)} chunks.")
        return {
            "success": True,
            "filename": file.filename,
            "chunksStored": len(chunks)
        }
        
    except Exception as e:
        logger.error(f"Error uploading document: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to process and index document: {str(e)}")

@app.delete("/api/documents/{filename}")
def delete_document(filename: str = Path(..., description="The exact name of the file to delete")):
    """Delete a document and all its chunks from the vector database."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                # Check if it exists
                cur.execute("SELECT COUNT(*) FROM document_chunk WHERE filename = %s", (filename,))
                count = cur.fetchone()[0]
                
                if count == 0:
                    raise HTTPException(status_code=404, detail=f"Document '{filename}' not found.")
                
                # Delete chunks
                cur.execute("DELETE FROM document_chunk WHERE filename = %s", (filename,))
                conn.commit()
                
        logger.info(f"purged {count} chunks of document '{filename}' from database.")
        return {"success": True, "message": f"Successfully deleted document '{filename}'."}
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Failed to delete document: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete document: {str(e)}")

@app.post("/api/documents/ask", response_model=AskResponse)
async def ask_question(request: AskRequest):
    """Query the RAG system using memory + hybrid search + reranking, and run deep RAG evaluations."""
    try:
        question = request.question.strip()
        history = request.history
        filters = request.filters
        
        logger.info(f"Received question: '{question}' with filters {filters} and history length {len(history)}")
        
        # 1. Execute RAG query (Condenses question, semantic/lexical search, reranking, source-aware prompt)
        rag_result = await run_rag_query(question, history, filters)
        
        # 2. Evaluate the RAG response (Faithfulness, Answer Relevance, Context Precision/Recall)
        evaluation = evaluate_rag_response(
            question=question,
            context_chunks=rag_result["retrieved_context"],
            answer=rag_result["answer"]
        )
        
        return {
            "answer": rag_result["answer"],
            "sources": rag_result["sources"],
            "evaluation": evaluation
        }
        
    except Exception as e:
        logger.error(f"Error in ask_question endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=f"An error occurred while answering your question: {str(e)}")
import json
import re
