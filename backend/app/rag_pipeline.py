import json
import re
import logging
from openai import OpenAI
from app.config import OPENAI_API_KEY
from app.database import get_db_connection

logger = logging.getLogger("rag-app")

def get_openai_client() -> OpenAI:
    if not OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY is not configured")
    return OpenAI(api_key=OPENAI_API_KEY)

async def embed_text(client: OpenAI, text: str) -> list[float]:
    """Generate vector embedding from OpenAI."""
    res = client.embeddings.create(
        model="text-embedding-3-small",
        input=text
    )
    return res.data[0].embedding

def condense_question(client: OpenAI, question: str, history: list[dict]) -> str:
    """Condense conversation history and current question into a standalone query."""
    if not history:
        return question
        
    history_text = ""
    # Use only last 6 messages to keep context window tight
    for msg in history[-6:]:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        history_text += f"{role.capitalize()}: {content}\n"
        
    prompt = f"""Given the following conversation history and a new question from the user, rephrase the new question to be a standalone question that can be searched in a vector database. It should not refer to pronouns like 'it', 'they', 'he', or previous questions.
If the question is already fully self-explanatory, output the original question exactly.
Do not write explanations, greetings, or formatting - output ONLY the standalone question.

Conversation History:
{history_text}

New User Question: {question}

Standalone Question:"""

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0
        )
        condensed = response.choices[0].message.content.strip()
        logger.info(f"Memory: Condensed '{question}' -> '{condensed}'")
        return condensed
    except Exception as e:
        logger.error(f"Error condensing question: {str(e)}")
        return question

def perform_hybrid_search(query: str, query_vector: list[float], filters: dict = None, limit: int = 20) -> list[dict]:
    """Execute dynamic hybrid search (Vector + Lexical Full-Text Search) and merge results via Reciprocal Rank Fusion (RRF)."""
    filter_clauses = []
    params = {}
    
    if filters:
        if filters.get("document"):
            filter_clauses.append("metadata->>'document' = %(document)s")
            params["document"] = filters["document"]
        if filters.get("chapter"):
            filter_clauses.append("metadata->>'chapter' = %(chapter)s")
            params["chapter"] = filters["chapter"]
        if filters.get("page"):
            filter_clauses.append("(metadata->>'page')::int = %(page)s")
            params["page"] = int(filters["page"])
            
    filter_sql = " AND " + " AND ".join(filter_clauses) if filter_clauses else ""
    
    vector_results = []
    fts_results = []
    
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            # 1. Vector semantic search
            vector_sql = f"""
                SELECT id, filename, content, metadata, embedding <=> %(query_vector)s::vector AS distance
                FROM document_chunk
                WHERE 1=1 {filter_sql}
                ORDER BY distance ASC
                LIMIT %(limit)s
            """
            vector_params = {**params, "query_vector": str(query_vector), "limit": limit}
            cur.execute(vector_sql, vector_params)
            colnames = [desc[0] for desc in cur.description]
            for row in cur.fetchall():
                vector_results.append(dict(zip(colnames, row)))
                
            # 2. Lexical full-text search (tsquery)
            # Create a simple plain text query (split by whitespace, joined by &)
            words = [w.strip() for w in re.split(r'\s+', query) if w.strip()]
            tsquery_str = " & ".join(f"{w}:*" for w in words) if words else ""
            
            if tsquery_str:
                fts_sql = f"""
                    SELECT id, filename, content, metadata, ts_rank_cd(tsv, to_tsquery('english', %(tsquery)s)) AS rank
                    FROM document_chunk
                    WHERE tsv @@ to_tsquery('english', %(tsquery)s) {filter_sql}
                    ORDER BY rank DESC
                    LIMIT %(limit)s
                """
                fts_params = {**params, "tsquery": tsquery_str, "limit": limit}
                try:
                    cur.execute(fts_sql, fts_params)
                    colnames = [desc[0] for desc in cur.description]
                    for row in cur.fetchall():
                        fts_results.append(dict(zip(colnames, row)))
                except Exception as e:
                    logger.error(f"FTS Search failed: {str(e)}. Using vector search only.")
                    
    # 3. Apply Reciprocal Rank Fusion (RRF)
    rrf_scores = {}
    doc_map = {}
    
    # Standard constant parameter
    K = 60
    
    for rank, doc in enumerate(vector_results):
        doc_id = str(doc["id"])
        doc_map[doc_id] = doc
        rrf_scores[doc_id] = rrf_scores.get(doc_id, 0.0) + (1.0 / (K + rank + 1))
        
    for rank, doc in enumerate(fts_results):
        doc_id = str(doc["id"])
        doc_map[doc_id] = doc
        # Convert distances/ranks to standard keys
        rrf_scores[doc_id] = rrf_scores.get(doc_id, 0.0) + (1.0 / (K + rank + 1))
        
    # Sort merged results by RRF score descending
    sorted_ids = sorted(rrf_scores.keys(), key=lambda x: rrf_scores[x], reverse=True)
    merged_results = [doc_map[doc_id] for doc_id in sorted_ids[:limit]]
    
    # Cast distance/rank keys safely for API compatibility
    for item in merged_results:
        if "distance" in item and item["distance"] is not None:
            item["distance"] = float(item["distance"])
        else:
            item["distance"] = 0.5  # default neutral distance if retrieved only by FTS
            
    logger.info(f"Hybrid Search: Vector retrieved {len(vector_results)}, FTS retrieved {len(fts_results)}. RRF Merged to {len(merged_results)} chunks.")
    return merged_results

def rerank_chunks(client: OpenAI, question: str, chunks: list[dict], top_n: int = 5) -> list[dict]:
    """Apply Zero-Shot LLM Reranking on merged search results to extract the most relevant chunks."""
    if not chunks:
        return []
    if len(chunks) <= top_n:
        return chunks
        
    chunk_list_str = ""
    for idx, doc in enumerate(chunks):
        metadata = doc.get("metadata", {})
        doc_name = metadata.get("document", "Unknown")
        chapter = metadata.get("chapter", "Intro")
        page = metadata.get("page", 0)
        content = doc.get("content", "")
        chunk_list_str += f"=== CHUNK INDEX {idx} ===\nDoc: {doc_name} (Ch: {chapter}, Pg: {page})\nText: {content}\n\n"
        
    prompt = f"""You are a highly precise search engine reranker. Rate how well each of the provided text chunks can answer the question below.
Score each chunk on a scale of 0.0 (completely irrelevant) to 10.0 (contains the perfect direct answer).

User Question: {question}

Retrieved Chunks:
{chunk_list_str}

You must return a valid JSON object. Do not output any markdown formatting, codeblocks, or explanations. Respond with ONLY the raw JSON string matching the schema:
{{
  "scores": [
    {{ "chunk_index": 0, "score": 9.5 }},
    {{ "chunk_index": 1, "score": 4.1 }}
  ]
}}
"""

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            response_format={"type": "json_object"}
        )
        data = json.loads(response.choices[0].message.content.strip())
        scores = data.get("scores", [])
        
        # Build mapping of scored chunks
        scored_chunks = []
        for s in scores:
            idx = s.get("chunk_index")
            score = float(s.get("score", 0.0))
            if 0 <= idx < len(chunks):
                scored_chunks.append((chunks[idx], score))
                
        # Fill in missing scores if any index was skipped
        scored_indices = {s.get("chunk_index") for s in scores}
        for idx, doc in enumerate(chunks):
            if idx not in scored_indices:
                scored_chunks.append((doc, 0.0))
                
        # Sort by score descending and return top_n
        scored_chunks.sort(key=lambda x: x[1], reverse=True)
        top_chunks = [item[0] for item in scored_chunks[:top_n]]
        logger.info(f"Reranking completed successfully. Rated {len(scored_chunks)} chunks. Retained best {len(top_chunks)}.")
        return top_chunks
    except Exception as e:
        logger.error(f"Reranker failed: {str(e)}. Falling back to standard order.")
        return chunks[:top_n]

async def run_rag_query(question: str, history: list[dict] = None, filters: dict = None) -> dict:
    """Orchestrate full Advanced RAG pipeline: memory -> embeddings -> hybrid search -> rerank -> LLM generation."""
    client = get_openai_client()
    
    # 1. Conversational memory question condensation
    search_query = condense_question(client, question, history or [])
    
    # 2. Embedding creation
    query_vector = await embed_text(client, search_query)
    
    # 3. Hybrid search (Retrieves Top 20)
    retrieved_chunks = perform_hybrid_search(search_query, query_vector, filters, limit=20)
    
    if not retrieved_chunks:
        return {
            "answer": "I don't know. (No document chunks are currently loaded in the system database. Please index a PDF first.)",
            "sources": [],
            "retrieved_context": []
        }
        
    # 4. Reranker (Selects Best 5)
    best_chunks = rerank_chunks(client, search_query, retrieved_chunks, top_n=5)
    
    # 5. LLM Source-Aware generation
    context_str = ""
    for idx, doc in enumerate(best_chunks):
        metadata = doc.get("metadata", {})
        doc_name = metadata.get("document", "Unknown")
        chapter = metadata.get("chapter", "Intro")
        page = metadata.get("page", 0)
        context_str += f"[{idx + 1}] (Document: {doc_name}, Chapter: {chapter}, Page: {page})\n{doc.get('content')}\n\n"
        
    system_prompt = """You are a helpful assistant for a document Q&A app. The user has uploaded PDF documents, and you are given retrieved context chunks from them.

Follow these rules:
1. If the user's message is a greeting, thanks, or casual small talk (e.g. "hi", "hello", "how are you", "thank you"), reply briefly and warmly and invite them to ask about their documents. Do NOT say "I don't know" and do NOT cite sources for small talk.
2. For an actual question, answer ONLY using facts directly stated in the retrieved context, and cite sources inline like [1], [2] matching the document numbers in the context.
3. If it is a genuine question about the documents but the answer is NOT contained in the context, respond EXACTLY with: "I don't know." Do not guess or use outside knowledge.
4. Keep answers professional, concise, and well-structured.
"""

    user_content = f"Retrieved Context:\n{context_str}\n\nQuestion: {question}"
    
    logger.info("Executing generation with source-aware prompt...")
    completion = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content}
        ],
        temperature=0.0
    )
    
    answer = completion.choices[0].message.content.strip()
    logger.info(f"Response generated successfully ({len(answer)} chars).")
    
    sources = []
    for doc in best_chunks:
        meta = doc.get("metadata", {})
        sources.append({
            "filename": meta.get("document", doc.get("filename", "")),
            "snippet": doc.get("content", "")[:200],
            "chapter": meta.get("chapter", "Intro"),
            "page": meta.get("page", 0),
            "distance": doc.get("distance", 0.5)
        })
        
    return {
        "answer": answer,
        "sources": sources,
        "retrieved_context": best_chunks  # pass this back so we can run metrics on it!
    }
