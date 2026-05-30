// The browser always calls same-origin Next.js API routes (/api/...). Those
// route handlers proxy to the FastAPI backend using the server-side BACKEND_URL
// env var — so the backend URL is never exposed and can change without a rebuild.
export const API_BASE = '';

export interface Source {
  filename: string;
  snippet: string;
  chapter: string;
  page: number;
  distance: number;
}

export interface Evaluation {
  faithfulness: number;
  answer_relevance: number;
  context_precision: number;
  context_recall: number;
  reasonings: {
    faithfulness: string;
    answer_relevance: string;
    context_precision: string;
    context_recall: string;
  };
}

export interface AskResponse {
  answer: string;
  sources: Source[];
  evaluation: Evaluation;
}

export interface UploadResponse {
  success: boolean;
  filename: string;
  chunksStored: number;
}

export interface DocumentItem {
  filename: string;
  chunk_count: number;
  page_count: number;
  created_at: string;
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    const msg = data.detail || data.message;
    if (Array.isArray(msg)) return msg.join(', ');
    return msg || res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function uploadPdf(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file);
  // Talk directly to API_BASE if NEXT_PUBLIC_API_URL is set, otherwise fall back to local relative API
  const url = API_BASE ? `${API_BASE}/api/documents/upload` : `/api/documents/upload`;
  const res = await fetch(url, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function listDocuments(): Promise<DocumentItem[]> {
  const url = API_BASE ? `${API_BASE}/api/documents` : `/api/documents`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function deleteDocument(filename: string): Promise<{ success: boolean }> {
  const url = API_BASE ? `${API_BASE}/api/documents/${encodeURIComponent(filename)}` : `/api/documents/${encodeURIComponent(filename)}`;
  const res = await fetch(url, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function askQuestion(
  question: string,
  history: { role: string; content: string }[] = [],
  filters: { document?: string; chapter?: string; page?: number } | null = null
): Promise<AskResponse> {
  const url = API_BASE ? `${API_BASE}/api/documents/ask` : `/api/documents/ask`;
  
  // Format body for FastAPI AskRequest
  const body: { question: string; history: any[]; filters: any } = {
    question,
    history,
    filters: filters && Object.keys(filters).length > 0 ? filters : null
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}
