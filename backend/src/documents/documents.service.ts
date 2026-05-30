import { Injectable, OnModuleInit, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import OpenAI from 'openai';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pgvector = require('pgvector');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1536;
const CHAT_MODEL = 'gpt-4o-mini';
const TOP_K = 5;

@Injectable()
export class DocumentsService implements OnModuleInit {
  private openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // Ensure pgvector extension, table and index exist (replaces typeorm synchronize for the vector type).
  async onModuleInit() {
    await this.dataSource.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS document_chunk (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        filename text NOT NULL DEFAULT '',
        content text NOT NULL,
        embedding vector(${EMBEDDING_DIM}) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Migrate older tables (created before these columns existed).
    await this.dataSource.query(
      `ALTER TABLE document_chunk ADD COLUMN IF NOT EXISTS filename text NOT NULL DEFAULT ''`,
    );
    await this.dataSource.query(
      `ALTER TABLE document_chunk ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
    );
    // Drop the old ivfflat index: with few rows it probes one (usually empty)
    // list and returns zero matches. Exact KNN (seqscan) is accurate and fast
    // enough here; add an HNSW index later if the table grows large.
    await this.dataSource.query(
      'DROP INDEX IF EXISTS document_chunk_embedding_idx',
    );
  }

  async processPdf(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const data = await pdfParse(file.buffer);
    const text = (data.text || '').trim();

    if (!text) {
      throw new BadRequestException('Could not extract text from PDF');
    }

    const chunks = this.chunkText(text);

    for (const chunk of chunks) {
      const embedding = await this.embed(chunk);
      await this.dataSource.query(
        'INSERT INTO document_chunk (filename, content, embedding) VALUES ($1, $2, $3)',
        [file.originalname, chunk, pgvector.toSql(embedding)],
      );
    }

    return {
      success: true,
      filename: file.originalname,
      chunksStored: chunks.length,
    };
  }

  async ask(question: string) {
    const q = (question || '').trim();
    if (!q) {
      throw new BadRequestException('Question is required');
    }

    const queryEmbedding = await this.embed(q);

    const rows: Array<{ content: string; filename: string; distance: number }> =
      await this.dataSource.query(
        `SELECT content, filename, embedding <=> $1::vector AS distance
         FROM document_chunk
         ORDER BY distance ASC
         LIMIT $2`,
        [pgvector.toSql(queryEmbedding), TOP_K],
      );

    if (rows.length === 0) {
      return {
        answer:
          'No documents found. Upload a PDF first, then ask your question.',
        sources: [],
      };
    }

    const context = rows
      .map((r, i) => `[${i + 1}] (${r.filename})\n${r.content}`)
      .join('\n\n');

    const completion = await this.openai.chat.completions.create({
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
        {
          role: 'user',
          content: `Context:\n${context}\n\nQuestion: ${q}`,
        },
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

  private async embed(input: string): Promise<number[]> {
    const res = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input,
    });
    return res.data[0].embedding;
  }

  // Word-aware chunking with overlap for better retrieval continuity.
  chunkText(text: string, chunkSize = 1000, overlap = 200): string[] {
    const clean = text.replace(/\s+/g, ' ').trim();
    const chunks: string[] = [];
    let i = 0;
    while (i < clean.length) {
      chunks.push(clean.slice(i, i + chunkSize));
      i += chunkSize - overlap;
    }
    return chunks;
  }
}
