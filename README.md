# RAG App — Ask your PDFs

Upload a PDF, then ask questions about it. The backend chunks the PDF, embeds
each chunk with OpenAI, stores the vectors in Postgres (`pgvector`), and answers
questions with semantic search + an LLM (retrieval-augmented generation).

```
PDF ──▶ chunk ──▶ embed (text-embedding-3-small) ──▶ pgvector
question ──▶ embed ──▶ cosine top-k ──▶ gpt-4o-mini ──▶ answer + sources
```

## Stack

| Layer    | Tech                                            |
| -------- | ----------------------------------------------- |
| Frontend | Next.js 15 (App Router, TypeScript)             |
| Backend  | NestJS 11, TypeORM                              |
| Vector DB| Postgres 16 + `pgvector`                        |
| AI       | OpenAI embeddings + chat completions            |

## Repo layout

```
backend/    NestJS API (upload + ask)
frontend/   Next.js UI (upload + chat)
docker/     init.sql placeholder
render.yaml Render Blueprint (backend + pgvector Postgres)
```

## API

| Method | Route                | Body                       | Returns                          |
| ------ | -------------------- | -------------------------- | -------------------------------- |
| GET    | `/health`            | —                          | `{ status, uptime }`             |
| POST   | `/documents/upload`  | `multipart/form-data` file | `{ success, filename, chunksStored }` |
| POST   | `/documents/ask`     | `{ "question": "..." }`    | `{ answer, sources[] }`          |

## Local development

### 1. Postgres (pgvector)

```bash
cd backend
docker compose up -d        # starts pgvector/pgvector:pg16 on localhost:5433
```

### 2. Backend

```bash
cd backend
cp .env.example .env        # set OPENAI_API_KEY
npm install
npm run start:dev           # http://localhost:3000
```

### 3. Frontend

```bash
cd frontend
cp .env.example .env.local  # NEXT_PUBLIC_API_URL=http://localhost:3000
npm install
npm run dev                 # http://localhost:3000 (use a different port if backend is on 3000)
```

## Deploy

### Backend — Render (free)

1. Push this repo to GitHub.
2. Render Dashboard → **New → Blueprint** → pick this repo. `render.yaml`
   provisions the web service **and** a free `pgvector` Postgres.
3. In the `rag-backend` service, set `OPENAI_API_KEY` and `CORS_ORIGIN`
   (your frontend URL).

The schema (extension, table, ivfflat index) is created automatically on boot.

A `Dockerfile` is also included for any container platform (Fly.io, Railway, etc.).

### Frontend — Vercel (free)

Import the repo, set **Root Directory** to `frontend`, and add
`NEXT_PUBLIC_API_URL` = your deployed backend URL.

## Environment variables

**Backend**

| Var               | Notes                                                       |
| ----------------- | ----------------------------------------------------------- |
| `OPENAI_API_KEY`  | required                                                    |
| `DATABASE_URL`    | prod connection string (enables SSL); overrides the vars below |
| `DATABASE_HOST/PORT/USER/PASSWORD/NAME` | local dev                              |
| `CORS_ORIGIN`     | comma-separated allowed origins (unset = allow all)         |
| `PORT`            | default 3000                                                |

**Frontend**

| Var                   | Notes                          |
| --------------------- | ------------------------------ |
| `NEXT_PUBLIC_API_URL` | backend base URL, no trailing `/` |
