'use client';

import { useRef, useState } from 'react';
import {
  uploadPdf,
  askQuestion,
  type AskResponse,
} from '@/lib/api';

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [askErr, setAskErr] = useState<string | null>(null);

  function pickFile(f: File | null) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.pdf')) {
      setUploadMsg({ text: 'Please select a PDF file.', ok: false });
      return;
    }
    setFile(f);
    setUploadMsg(null);
  }

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setUploadMsg(null);
    try {
      const res = await uploadPdf(file);
      setUploadMsg({
        text: `Indexed "${res.filename}" — ${res.chunksStored} chunks stored. Ask away!`,
        ok: true,
      });
    } catch (e) {
      setUploadMsg({ text: (e as Error).message, ok: false });
    } finally {
      setUploading(false);
    }
  }

  async function handleAsk() {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setAskErr(null);
    setResult(null);
    try {
      const res = await askQuestion(q);
      setResult(res);
    } catch (e) {
      setAskErr((e as Error).message);
    } finally {
      setAsking(false);
    }
  }

  return (
    <main className="container">
      <div className="header">
        <h1>Ask your PDFs</h1>
        <p>
          Upload a PDF, then ask questions. Answers come from semantic search
          over your document plus an LLM.
        </p>
      </div>

      <section className="card">
        <h2>1 · Upload a PDF</h2>
        <div
          className={`dropzone${drag ? ' drag' : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pickFile(e.dataTransfer.files?.[0] ?? null);
          }}
        >
          {file ? (
            <div className="file-name">{file.name}</div>
          ) : (
            <div className="file-name">Drop a PDF here or click to browse</div>
          )}
          <div className="hint">Max 20 MB · PDF only</div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            style={{ display: 'none' }}
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div style={{ marginTop: 14 }}>
          <button onClick={handleUpload} disabled={!file || uploading}>
            {uploading && <span className="spinner" />}
            {uploading ? 'Indexing…' : 'Upload & Index'}
          </button>
        </div>
        {uploadMsg && (
          <div className={`status ${uploadMsg.ok ? 'ok' : 'err'}`}>
            {uploadMsg.text}
          </div>
        )}
      </section>

      <section className="card">
        <h2>2 · Ask a question</h2>
        <div className="row">
          <input
            type="text"
            placeholder="e.g. What is the main conclusion of this paper?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAsk();
            }}
          />
          <button onClick={handleAsk} disabled={!question.trim() || asking}>
            {asking && <span className="spinner" />}
            {asking ? 'Thinking…' : 'Ask'}
          </button>
        </div>
        {askErr && <div className="status err">{askErr}</div>}

        {result && (
          <div style={{ marginTop: 18 }}>
            <div className="answer">{result.answer}</div>
            {result.sources.length > 0 && (
              <div className="sources">
                <h2 style={{ marginBottom: 8 }}>Sources</h2>
                {result.sources.map((s, i) => (
                  <div className="source" key={i}>
                    <b>
                      [{i + 1}] {s.filename}
                    </b>{' '}
                    — {s.snippet}…
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <div className="footer">RAG App · Next.js + NestJS + pgvector + OpenAI</div>
    </main>
  );
}
