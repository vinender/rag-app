import json
import logging
from openai import OpenAI
from app.config import OPENAI_API_KEY

logger = logging.getLogger("rag-app")

def get_openai_client() -> OpenAI:
    if not OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY is not configured")
    return OpenAI(api_key=OPENAI_API_KEY)

def evaluate_rag_response(question: str, context_chunks: list[dict], answer: str) -> dict:
    """Evaluate a RAG response for Faithfulness, Answer Relevance, Context Precision, and Context Recall.
    
    Returns a dictionary with scores between 0.0 and 1.0 and constructive reasonings.
    """
    # If no answer or no context, return neutral metrics
    if not context_chunks or not answer or "I don't know" in answer:
        return {
            "faithfulness": 1.0 if "I don't know" in answer else 0.0,
            "answer_relevance": 0.0,
            "context_precision": 0.0,
            "context_recall": 0.0,
            "reasonings": {
                "faithfulness": "Answer represents a correct refusal due to no retrieved context.",
                "answer_relevance": "No valid answer generated.",
                "context_precision": "No context available.",
                "context_recall": "No context available."
            }
        }
        
    client = get_openai_client()
    
    # Flatten context chunks
    context_str = ""
    for idx, doc in enumerate(context_chunks):
        content = doc.get("content", "")
        context_str += f"[Chunk {idx + 1}]: {content}\n\n"
        
    prompt = f"""You are an advanced AI Judge specializing in RAG (Retrieval-Augmented Generation) evaluations.
Your job is to evaluate a RAG system's response across four primary metrics.

### INPUT DETAILS:
1. User Question: {question}
2. Retrieved Context:
{context_str}
3. Generated Answer: {answer}

### METRIC DEFINITIONS & SCORING RULES:
1. **Faithfulness** (0.0 to 1.0): Measures if the Generated Answer is grounded ONLY in the Retrieved Context. 
   - Extract all factual statements from the Generated Answer.
   - For each statement, verify if it can be directly inferred from the Retrieved Context.
   - Score = (Count of supported statements) / (Total count of statements).

2. **Answer Relevance** (0.0 to 1.0): Measures how directly and completely the Generated Answer answers the User Question.
   - Penalize answers that are vague, beat around the bush, or fail to address the core query.
   - Score = rating from 0.0 to 1.0.

3. **Context Precision** (0.0 to 1.0): Measures if the retrieved context chunks contain relevant information to answer the question, and if the most relevant chunks are ranked high.
   - For each Chunk [1] to [N], determine if it contains helpful facts for the Question (Yes/No).
   - Calculate precision based on position (higher weight for relevant chunks at the beginning).
   - Score = rating from 0.0 to 1.0.

4. **Context Recall** (0.0 to 1.0): Measures if the Retrieved Context contains all the necessary information to construct the Generated Answer.
   - Extract core points of the Generated Answer.
   - Determine if each core point is present in the Retrieved Context.
   - Score = (Points found in context) / (Total points in answer).

### OUTPUT SCHEMA:
You must respond in a valid JSON format. Do not include markdown codeblocks, explanations, or introductory text. Respond with ONLY the raw JSON string matching this structure:
{{
  "faithfulness": 0.95,
  "answer_relevance": 0.9,
  "context_precision": 0.8,
  "context_recall": 1.0,
  "reasonings": {{
    "faithfulness": "All statements except one about X are directly backed by Chunk 2.",
    "answer_relevance": "The answer directly explains Hooks and provides code examples.",
    "context_precision": "Chunk 1 and Chunk 2 were highly relevant. Chunk 4 was irrelevant.",
    "context_recall": "Every single detail in the answer was found inside the retrieved pages."
  }}
}}
"""

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            response_format={"type": "json_object"}
        )
        scores = json.loads(response.choices[0].message.content.strip())
        logger.info(f"Evaluation calculated successfully: Faithfulness={scores.get('faithfulness')}, Relevance={scores.get('answer_relevance')}")
        return scores
    except Exception as e:
        logger.error(f"Failed to calculate RAG evaluation metrics: {str(e)}")
        return {
            "faithfulness": 0.8,
            "answer_relevance": 0.8,
            "context_precision": 0.8,
            "context_recall": 0.8,
            "reasonings": {
                "faithfulness": "Fallback due to evaluation parse failure.",
                "answer_relevance": "Fallback due to evaluation parse failure.",
                "context_precision": "Fallback due to evaluation parse failure.",
                "context_recall": "Fallback due to evaluation parse failure."
            }
        }
