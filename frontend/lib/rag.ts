import { neon } from '@neondatabase/serverless';
import OpenAI from 'openai';
import pgvector from 'pgvector';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1536;
const CHAT_MODEL = 'gpt-4o-mini';
const TOP_K = 5;

function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return neon(url);
}

let openaiClient: OpenAI | null = null;
function getOpenAI() {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

// Run schema setup once per warm instance.
let schemaReady: Promise<void> | null = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getSql();
      await sql.query('CREATE EXTENSION IF NOT EXISTS vector');
      await sql.query(`
        CREATE TABLE IF NOT EXISTS document_chunk (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          filename text NOT NULL DEFAULT '',
          content text NOT NULL,
          embedding vector(${EMBEDDING_DIM}) NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      // Drop the old ivfflat index: with few rows it probes one (usually empty)
      // list and returns zero matches. Exact KNN (seqscan) is accurate and fast
      // enough here; add an HNSW index later if the table grows large.
      await sql.query('DROP INDEX IF EXISTS document_chunk_embedding_idx');
    })().catch((e) => {
      // reset so the next request retries instead of caching a failure
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

async function embed(input: string): Promise<number[]> {
  const res = await getOpenAI().embeddings.create({
    model: EMBEDDING_MODEL,
    input,
  });
  return res.data[0].embedding;
}

// Word-aware chunking with overlap for retrieval continuity.
export function chunkText(text: string, chunkSize = 1000, overlap = 200): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    chunks.push(clean.slice(i, i + chunkSize));
    i += chunkSize - overlap;
  }
  return chunks;
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join('\n') : text).trim();
}

export async function processPdf(buffer: Buffer, filename: string) {
  await ensureSchema();
  const text = await extractPdfText(buffer);
  if (!text) throw new Error('Could not extract text from PDF');

  const chunks = chunkText(text);
  const sql = getSql();

  for (const chunk of chunks) {
    const vector = pgvector.toSql(await embed(chunk));
    await sql.query(
      'INSERT INTO document_chunk (filename, content, embedding) VALUES ($1, $2, $3::vector)',
      [filename, chunk, vector],
    );
  }

  return { success: true, filename, chunksStored: chunks.length };
}

export interface Source {
  filename: string;
  snippet: string;
  distance: number;
}

export async function ask(question: string) {
  const q = (question || '').trim();
  if (!q) throw new Error('Question is required');

  await ensureSchema();
  const sql = getSql();
  const queryVector = pgvector.toSql(await embed(q));

  const rows = (await sql.query(
    `SELECT content, filename, embedding <=> $1::vector AS distance
     FROM document_chunk
     ORDER BY distance ASC
     LIMIT $2`,
    [queryVector, TOP_K],
  )) as Array<{ content: string; filename: string; distance: number }>;

  if (rows.length === 0) {
    return {
      answer: 'No documents found. Upload a PDF first, then ask your question.',
      sources: [] as Source[],
    };
  }

  const context = rows
    .map((r, i) => `[${i + 1}] (${r.filename})\n${r.content}`)
    .join('\n\n');

  const completion = await getOpenAI().chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'You answer questions strictly using the provided context from uploaded documents. ' +
          'If the answer is not in the context, say you could not find it in the documents. ' +
          'Cite the source numbers like [1], [2] when relevant.',
      },
      { role: 'user', content: `Context:\n${context}\n\nQuestion: ${q}` },
    ],
  });

  const answer =
    completion.choices[0]?.message?.content?.trim() || 'No answer generated.';

  return {
    answer,
    sources: rows.map((r) => ({
      filename: r.filename,
      snippet: r.content.slice(0, 200),
      distance: Number(r.distance),
    })),
  };
}
