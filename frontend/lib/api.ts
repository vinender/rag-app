export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ||
  'http://localhost:3000';

export interface Source {
  filename: string;
  snippet: string;
  distance: number;
}

export interface AskResponse {
  answer: string;
  sources: Source[];
}

export interface UploadResponse {
  success: boolean;
  filename: string;
  chunksStored: number;
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    const msg = data.message;
    if (Array.isArray(msg)) return msg.join(', ');
    return msg || res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function uploadPdf(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/documents/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function askQuestion(question: string): Promise<AskResponse> {
  const res = await fetch(`${API_BASE}/documents/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}
