import re
import io
import base64
import logging
from pypdf import PdfReader
from openai import OpenAI
from app.config import OPENAI_API_KEY

logger = logging.getLogger("rag-app")

def get_openai_client() -> OpenAI:
    if not OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY is not configured")
    return OpenAI(api_key=OPENAI_API_KEY)

def detect_chapter(text: str, current_chapter: str) -> str:
    """Scan page text for potential chapter headings and return the detected chapter name or current_chapter."""
    # Match patterns like "Chapter 1: Hooks" or "Section 3 - Reranking"
    match = re.search(r'(?:Chapter|Section|CHAPTER|SECTION)\s+\d+[:.]?\s*([A-Za-z\s\-]{3,40})', text)
    if match and match.group(1):
        return match.group(1).strip()
    
    # Match markdown headers like "# Hooks"
    md_match = re.search(r'(?:^|\n)#+\s+([A-Za-z\s\-]{3,40})', text)
    if md_match and md_match.group(1):
        return md_match.group(1).strip()
    
    return current_chapter or "Introduction"

def ocr_image_via_openai(client: OpenAI, image_bytes: bytes) -> str:
    """Perform high-fidelity OCR on an extracted page image using GPT-4o-mini Vision."""
    try:
        base64_image = base64.b64encode(image_bytes).decode('utf-8')
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "This is an image of a scanned page from a document. Transcribe all text in this image accurately and preserve structural flow. Do not include any explanations, greetings, or formatting markdown - return ONLY the transcribed text."
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{base64_image}"
                            }
                        }
                    ]
                }
            ],
            max_tokens=1500,
            temperature=0.0
        )
        transcription = response.choices[0].message.content.strip()
        logger.info(f"Successfully performed GPT OCR on page image ({len(transcription)} chars extracted)")
        return transcription
    except Exception as e:
        logger.error(f"Failed to perform GPT OCR: {str(e)}")
        return ""

def chunk_text(text: str, chunk_size: int = 1000, overlap: int = 200) -> list[str]:
    """Split text into overlapping chunks of a target character length."""
    clean = re.sub(r'\s+', ' ', text).strip()
    if not clean:
        return []
    
    chunks = []
    i = 0
    while i < len(clean):
        chunks.append(clean[i : i + chunk_size])
        i += chunk_size - overlap
    return chunks

def process_pdf_pages(file_bytes: bytes, filename: str) -> list[dict]:
    """Parse PDF page-by-page. For each page, extract text, detect chapter, chunk text, and compile chunks with metadata."""
    client = get_openai_client()
    pdf_file = io.BytesIO(file_bytes)
    reader = PdfReader(pdf_file)
    
    all_chunks = []
    current_chapter = "Introduction"
    
    logger.info(f"Processing PDF '{filename}' with {len(reader.pages)} pages...")
    
    for idx, page in enumerate(reader.pages):
        page_num = idx + 1
        page_text = page.extract_text() or ""
        page_text = page_text.strip()
        
        # If very little/no text is extracted, check for scanned page (OCR Fallback)
        if len(page_text) < 50:
            logger.info(f"Page {page_num} of {filename} has low text content ({len(page_text)} chars). Checking for OCR fallback...")
            # Try to extract images from page to OCR
            extracted_ocr_text = []
            if hasattr(page, "images") and len(page.images) > 0:
                for img_idx, img in enumerate(page.images):
                    logger.info(f"Extracting image {img_idx + 1} from page {page_num} for OCR...")
                    ocr_text = ocr_image_via_openai(client, img.data)
                    if ocr_text:
                        extracted_ocr_text.append(ocr_text)
            
            if extracted_ocr_text:
                page_text = "\n\n".join(extracted_ocr_text)
            else:
                logger.warning(f"Page {page_num} has no text and no extractable images.")
        
        if not page_text:
            continue
            
        # Detect/Update current chapter
        current_chapter = detect_chapter(page_text, current_chapter)
        
        # Chunk text
        chunks = chunk_text(page_text, chunk_size=1000, overlap=200)
        logger.info(f"Page {page_num}: Chapter = '{current_chapter}', Chunks = {len(chunks)}")
        
        # Build chunk dictionaries
        for chunk in chunks:
            all_chunks.append({
                "content": chunk,
                "metadata": {
                    "document": filename,
                    "page": page_num,
                    "chapter": current_chapter
                }
            })
            
    return all_chunks
