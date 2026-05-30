# RAG App — Ask your PDFs

Upload a PDF, then ask questions about it. The app chunks the PDF, embeds each
chunk with OpenAI, stores the vectors in Postgres (`pgvector`), and answers
questions with semantic search + an LLM (retrieval-augmented generation).

```
PDF ──▶ chunk ──▶ embed (text-embedding-3-small) ──▶ pgvector
question ──▶ embed ──▶ cosine top-k ──▶ gpt-4o-mini ──▶ answer + sources
```

## Two ways to run it

This repo ships **two interchangeable backends** over the same Postgres+pgvector data:

1. **Serverless (recommended, free-tier friendly)** — RAG logic lives in Next.js
   API routes (`frontend/app/api/...`). Deploy the whole app to **Vercel** with a
   **Neon** Postgres. No separate server, no cold-start backend, DB never expires.
2. **Standalone NestJS** — `backend/` is a full NestJS service (Docker/Render).
   Use it if you want the API decoupled from the UI.

Pick one. The frontend talks to its own `/api` routes by default; set
`NEXT_PUBLIC_API_URL` to point at the NestJS service instead.

## Stack

| Layer     | Tech                                          |
| --------- | --------------------------------------------- |
| Frontend  | Next.js 16 (App Router, TypeScript)           |
| API       | Next.js route handlers **or** NestJS 11       |
| Vector DB | Postgres + `pgvector` (Neon, Supabase, or self-hosted) |
| AI        | OpenAI embeddings + chat completions          |

## Repo layout

```
frontend/   Next.js UI + serverless RAG API routes (app/api/documents/*)
frontend/lib/rag.ts   chunk + embed + pgvector search + chat
backend/    Standalone NestJS API (alternative to the serverless routes)
render.yaml Render Blueprint for the NestJS backend
docker/     init.sql placeholder
```

## API (identical for both backends)

| Method | Route                | Body                       | Returns                          |
| ------ | -------------------- | -------------------------- | -------------------------------- |
| POST   | `/documents/upload`  | `multipart/form-data` file | `{ success, filename, chunksStored }` |
| POST   | `/documents/ask`     | `{ "question": "..." }`    | `{ answer, sources[] }`          |

In serverless mode the routes are prefixed with `/api`.

---

## Deploy: Vercel + Neon (free)

1. **Create a Neon Postgres** at [neon.tech](https://neon.tech) (free, has
   `pgvector`). Copy the connection string (`postgres://...?sslmode=require`).
2. **Import the repo on Vercel**, set **Root Directory** = `frontend`.
3. Add environment variables in Vercel (Project → Settings → Environment Variables):

   | Var              | Value                                  |
   | ---------------- | -------------------------------------- |
   | `DATABASE_URL`   | your Neon connection string            |
   | `OPENAI_API_KEY` | your OpenAI key                        |

4. Deploy. The schema (extension, table, ivfflat index) is created on first request.

> Vercel Hobby is free and non-commercial. Functions run up to 60s
> (`maxDuration` is set in the route handlers) — enough for typical PDFs;
> very large PDFs may need batching or the standalone backend.

## Deploy: NestJS on Render (alternative)

Render Dashboard → **New → Blueprint** → pick this repo. `render.yaml`
provisions a Docker web service. Provide your own pgvector Postgres via
`DATABASE_URL` (Neon/Supabase) and set `OPENAI_API_KEY` + `CORS_ORIGIN`.
Then build the frontend with `NEXT_PUBLIC_API_URL=<backend-url>`.

---

## Local development

### Serverless mode (Next.js routes)

```bash
cd frontend
cp .env.example .env.local   # set DATABASE_URL (Neon) + OPENAI_API_KEY
npm install
npm run dev                  # http://localhost:3000
```

> The serverless DB layer uses Neon's HTTP driver, so a Neon `DATABASE_URL`
> is required even locally.

### Standalone NestJS mode

```bash
cd backend
docker compose up -d         # pgvector Postgres on localhost:5433
cp .env.example .env         # set OPENAI_API_KEY
npm install
npm run start:dev            # http://localhost:3000
```

## Environment variables

**Serverless / frontend**

| Var                   | Notes                                              |
| --------------------- | -------------------------------------------------- |
| `DATABASE_URL`        | Neon (or other) pgvector connection string         |
| `OPENAI_API_KEY`      | required                                            |
| `NEXT_PUBLIC_API_URL` | optional — set to use the standalone NestJS backend instead of `/api` |

**NestJS backend**

| Var               | Notes                                                       |
| ----------------- | ----------------------------------------------------------- |
| `OPENAI_API_KEY`  | required                                                    |
| `DATABASE_URL`    | prod connection string (enables SSL); overrides discrete vars |
| `DATABASE_HOST/PORT/USER/PASSWORD/NAME` | local dev                             |
| `CORS_ORIGIN`     | comma-separated allowed origins (unset = allow all)         |
| `PORT`            | default 3000                                                |
