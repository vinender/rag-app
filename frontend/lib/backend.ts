// Server-side only. Resolves the FastAPI backend base URL from env.
// Set BACKEND_URL in your environment (Vercel: Project → Settings → Env Vars)
// to the deployed FastAPI service, e.g. https://rag-backend.onrender.com
// Falls back to localhost:8000 for local `next dev` against a local uvicorn.
export function backendBase(): string {
  const url =
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    (process.env.NODE_ENV !== 'production' ? 'http://localhost:8000' : '');
  if (!url) {
    throw new Error(
      'BACKEND_URL is not set. Point it at the deployed FastAPI backend.',
    );
  }
  return url.replace(/\/$/, '');
}
