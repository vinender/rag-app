'use client';

import { useEffect, useRef, useState } from 'react';
import {
  uploadPdf,
  listDocuments,
  deleteDocument,
  askQuestion,
  type DocumentItem,
  type Source,
  type Evaluation,
} from '@/lib/api';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  evaluation?: Evaluation;
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
}

const SESSIONS_KEY = 'rag.sessions.v1';
const ACTIVE_KEY = 'rag.activeSession.v1';

function newId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function blankSession(): ChatSession {
  return { id: newId(), title: 'New Chat', messages: [], createdAt: Date.now() };
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sidebarFileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // App States
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [activeTab, setActiveTab] = useState<'chat' | 'dashboard'>('chat');
  const [loadingDocs, setLoadingDocs] = useState(true);

  // Chat sessions (ChatGPT-style: list on the left, messages on the right)
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Upload States
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStep, setUploadStep] = useState('');
  const [uploadMsg, setUploadMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [drag, setDrag] = useState(false);

  // Chat States
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [latestEval, setLatestEval] = useState<Evaluation | null>(null);
  const [latestQuestion, setLatestQuestion] = useState('');
  const [openCitationIdx, setOpenCitationIdx] = useState<string | null>(null);

  // Filter States
  const [filters, setFilters] = useState<{ document: string; chapter: string; page: string }>({
    document: '',
    chapter: '',
    page: '',
  });

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const messages = activeSession?.messages ?? [];

  // Load persisted sessions + indexed documents on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      const savedActive = localStorage.getItem(ACTIVE_KEY);
      if (raw) {
        const parsed: ChatSession[] = JSON.parse(raw);
        setSessions(parsed);
        setActiveId(savedActive && parsed.some((s) => s.id === savedActive) ? savedActive : parsed[0]?.id ?? null);
      }
    } catch {
      /* ignore corrupt storage */
    }
    setHydrated(true);
    fetchDocs();
  }, []);

  // Persist sessions whenever they change (after hydration)
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
      if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
    } catch {
      /* storage full / unavailable */
    }
  }, [sessions, activeId, hydrated]);

  // Ensure there's always an active chat once documents exist
  useEffect(() => {
    if (!hydrated) return;
    if (documents.length > 0 && sessions.length === 0) {
      const s = blankSession();
      setSessions([s]);
      setActiveId(s.id);
    }
  }, [hydrated, documents.length, sessions.length]);

  // Auto-scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, asking]);

  async function fetchDocs() {
    try {
      const docs = await listDocuments();
      setDocuments(docs);
    } catch (e) {
      console.error('Failed to load documents:', e);
    } finally {
      setLoadingDocs(false);
    }
  }

  // --- Session helpers ---
  function createSession(): string {
    const s = blankSession();
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    return s.id;
  }

  function deleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (id === activeId) setActiveId(next[0]?.id ?? null);
      return next;
    });
  }

  function patchSession(id: string, msgs: ChatMessage[]) {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        // Derive a title from the first user message
        let title = s.title;
        if (title === 'New Chat') {
          const firstUser = msgs.find((m) => m.role === 'user');
          if (firstUser) title = firstUser.content.slice(0, 40) + (firstUser.content.length > 40 ? '…' : '');
        }
        return { ...s, title, messages: msgs };
      }),
    );
  }

  // Triggered when user drops or selects a PDF — indexing starts immediately
  async function handleFileSelect(selectedFile: File | null) {
    if (!selectedFile) return;
    if (!selectedFile.name.toLowerCase().endsWith('.pdf')) {
      setUploadMsg({ text: 'Please select a valid PDF document.', ok: false });
      return;
    }

    setUploading(true);
    setUploadMsg(null);
    setUploadProgress(15);
    setUploadStep('Reading PDF structure...');

    const progressInterval = setInterval(() => {
      setUploadProgress((prev) => {
        if (prev < 40) {
          setUploadStep('Extracting page text...');
          return prev + 5;
        } else if (prev < 70) {
          setUploadStep('Running OCR fallback checks...');
          return prev + 3;
        } else if (prev < 90) {
          setUploadStep('Generating vector embeddings...');
          return prev + 2;
        }
        setUploadStep('Inserting into pgvector & building GIN indexes...');
        return prev;
      });
    }, 600);

    try {
      const res = await uploadPdf(selectedFile);
      clearInterval(progressInterval);
      setUploadProgress(100);
      setUploadStep('Indexing complete!');
      setUploadMsg({
        text: `Indexed "${res.filename}" successfully — ${res.chunksStored} chunks stored.`,
        ok: true,
      });
      await fetchDocs();
    } catch (e) {
      clearInterval(progressInterval);
      setUploadMsg({ text: (e as Error).message, ok: false });
    } finally {
      setTimeout(() => {
        setUploading(false);
        setUploadProgress(0);
        setUploadStep('');
      }, 1500);
    }
  }

  async function handleDeleteDoc(filename: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Are you sure you want to delete and purge all chunks of "${filename}"?`)) return;
    try {
      await deleteDocument(filename);
      await fetchDocs();
      setUploadMsg({ text: `purged document "${filename}" from database.`, ok: true });
      if (filters.document === filename) {
        setFilters((prev) => ({ ...prev, document: '' }));
      }
    } catch (err) {
      setUploadMsg({ text: (err as Error).message, ok: false });
    }
  }

  async function handleAsk() {
    const q = question.trim();
    if (!q || asking) return;

    // Ensure an active session
    let sid = activeId;
    if (!sid || !sessions.some((s) => s.id === sid)) {
      sid = createSession();
    }
    const current = sessions.find((s) => s.id === sid)?.messages ?? [];
    const apiHistory = current.map((m) => ({ role: m.role, content: m.content }));

    setAsking(true);
    setQuestion('');
    setLatestQuestion(q);

    const withUser: ChatMessage[] = [...current, { role: 'user', content: q }];
    patchSession(sid, withUser);

    try {
      const activeFilters: { document?: string; chapter?: string; page?: number } = {};
      if (filters.document) activeFilters.document = filters.document;
      if (filters.chapter.trim()) activeFilters.chapter = filters.chapter.trim();
      if (filters.page) activeFilters.page = Number(filters.page);

      const res = await askQuestion(q, apiHistory, activeFilters);

      patchSession(sid, [
        ...withUser,
        { role: 'assistant', content: res.answer, sources: res.sources, evaluation: res.evaluation },
      ]);
      setLatestEval(res.evaluation);
    } catch (e) {
      patchSession(sid, [
        ...withUser,
        { role: 'assistant', content: `An error occurred: ${(e as Error).message}` },
      ]);
    } finally {
      setAsking(false);
    }
  }

  function getStrokeColor(score: number): string {
    if (score >= 0.8) return 'var(--success)';
    if (score >= 0.5) return '#fbbf24';
    return 'var(--error)';
  }

  function renderGauge(score: number, title: string, desc: string, reasoning: string) {
    const radius = 45;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - score * circumference;
    const color = getStrokeColor(score);

    return (
      <div className="card metric-card">
        <div className="metric-dial">
          <svg width="120" height="120" className="progress-ring">
            <circle stroke="rgba(255, 255, 255, 0.03)" strokeWidth="8" fill="transparent" r={radius} cx="60" cy="60" />
            <circle
              className="progress-ring-circle"
              stroke={color}
              strokeWidth="8"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeLinecap="round"
              fill="transparent"
              r={radius}
              cx="60"
              cy="60"
              style={{ strokeDashoffset, filter: `drop-shadow(0 0 6px ${color}50)` }}
            />
          </svg>
          <div className="metric-value">{Math.round(score * 100)}%</div>
        </div>
        <div className="metric-name">{title}</div>
        <div className="metric-desc">{desc}</div>
        <div className="metric-reasoning">{reasoning || 'N/A'}</div>
      </div>
    );
  }

  if (loadingDocs) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh', backgroundColor: 'var(--bg)' }}>
        <div className="circular-loader">
          <svg width="60" height="60" className="progress-ring">
            <circle stroke="var(--border-color)" strokeWidth="4" fill="transparent" r="25" cx="30" cy="30" />
            <circle
              stroke="var(--accent)"
              strokeWidth="4"
              strokeDasharray="157 157"
              strokeDashoffset="60"
              strokeLinecap="round"
              fill="transparent"
              r="25"
              cx="30"
              cy="30"
              className="progress-ring-circle"
              style={{ animation: 'spin 1.2s linear infinite' }}
            />
          </svg>
          <div className="loader-msg" style={{ color: 'var(--fg-muted)' }}>
            Connecting to RAG engine...
          </div>
        </div>
      </div>
    );
  }

  const hasDocs = documents.length > 0;

  return (
    <div className="app-container">
      {/* Header */}
      <div className="header-wrapper">
        <div className="brand-section">
          <div className="brand-logo">R</div>
          <div className="brand-title">
            <h1>RAG-App</h1>
            <p>Hybrid Semantic Search · Reranking · Observability</p>
          </div>
        </div>
        {hasDocs && (
          <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            System Status: <span style={{ color: 'var(--success)', fontWeight: 600 }}>● Online</span> ({documents.length} PDFs loaded)
          </div>
        )}
      </div>

      {/* Sidebar */}
      <aside className="sidebar">
        {/* Chat session list (only once at least one PDF is indexed) */}
        {hasDocs && (
          <div className="card">
            <div className="chats-head">
              <h2 style={{ margin: 0 }}>
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                Chats
              </h2>
              <button className="new-chat-btn" onClick={createSession} title="Start a new chat">
                + New
              </button>
            </div>
            <div className="session-list">
              {sessions.length === 0 && <div className="empty-docs">No chats yet</div>}
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`session-item${s.id === activeId ? ' active' : ''}`}
                  onClick={() => setActiveId(s.id)}
                >
                  <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <span className="session-title">{s.title}</span>
                  <button className="delete-btn" onClick={(e) => deleteSession(s.id, e)} title="Delete chat">
                    <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Document Manager */}
        {hasDocs && (
          <div className="card">
            <h2>
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
                <path d="M6 6h10M6 10h10" />
              </svg>
              Indexed Library
            </h2>
            <div className="doc-list">
              {documents.map((doc, idx) => (
                <div className="doc-item" key={idx}>
                  <div className="doc-info">
                    <div className="doc-name" title={doc.filename}>
                      {doc.filename}
                    </div>
                    <div className="doc-meta">
                      {doc.page_count} pages · {doc.chunk_count} chunks
                    </div>
                  </div>
                  <button className="delete-btn" onClick={(e) => handleDeleteDoc(doc.filename, e)} title="Delete document">
                    <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Metadata Filters */}
        {hasDocs && (
          <div className="card">
            <h2>
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
              </svg>
              Metadata Filters
            </h2>
            <div className="filter-group">
              <div className="filter-item">
                <span className="filter-label">Restrict Document</span>
                <select value={filters.document} onChange={(e) => setFilters((f) => ({ ...f, document: e.target.value }))}>
                  <option value="">Query All Documents</option>
                  {documents.map((doc, idx) => (
                    <option key={idx} value={doc.filename}>
                      {doc.filename}
                    </option>
                  ))}
                </select>
              </div>
              <div className="filter-item">
                <span className="filter-label">Restrict Chapter</span>
                <input type="text" placeholder="e.g. Hooks" value={filters.chapter} onChange={(e) => setFilters((f) => ({ ...f, chapter: e.target.value }))} />
              </div>
              <div className="filter-item">
                <span className="filter-label">Restrict Page Number</span>
                <input type="number" placeholder="e.g. 14" min="1" value={filters.page} onChange={(e) => setFilters((f) => ({ ...f, page: e.target.value }))} />
              </div>
            </div>
          </div>
        )}

        {/* Index another PDF */}
        {hasDocs && (
          <div className="card">
            <h2>
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
              </svg>
              Index Another PDF
            </h2>
            {uploading ? (
              <div className="circular-loader">
                <svg width="48" height="48" className="progress-ring">
                  <circle stroke="rgba(255,255,255,0.03)" strokeWidth="4" fill="transparent" r="20" cx="24" cy="24" />
                  <circle
                    stroke="var(--accent)"
                    strokeWidth="4"
                    strokeDasharray="125.6 125.6"
                    strokeDashoffset={125.6 - (uploadProgress / 100) * 125.6}
                    strokeLinecap="round"
                    fill="transparent"
                    r="20"
                    cx="24"
                    cy="24"
                    className="progress-ring-circle"
                  />
                </svg>
                <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>{uploadStep}</div>
              </div>
            ) : (
              <div
                className={`dropzone${drag ? ' drag' : ''}`}
                onClick={() => sidebarFileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  handleFileSelect(e.dataTransfer.files?.[0] ?? null);
                }}
                style={{ padding: '20px 10px' }}
              >
                <div className="drop-icon">↑</div>
                <div className="hint">Drop PDF to index instantly</div>
                <input
                  ref={sidebarFileInputRef}
                  type="file"
                  accept="application/pdf"
                  style={{ display: 'none' }}
                  onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
                />
              </div>
            )}
            {uploadMsg && <div className={`status-toast ${uploadMsg.ok ? 'success' : 'error'}`}>{uploadMsg.text}</div>}
          </div>
        )}
      </aside>

      {/* Main panel */}
      <main className="main-panel">
        {!hasDocs ? (
          /* Empty state: upload only — chat/ask hidden until a PDF is indexed */
          <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
            <div className="card" style={{ maxWidth: 500, width: '100%', padding: '36px' }}>
              <div style={{ textAlign: 'center', marginBottom: 24 }}>
                <h2 style={{ fontSize: 18, color: 'var(--fg)', textTransform: 'none', letterSpacing: 'normal', justifyContent: 'center' }}>
                  Index a PDF to start
                </h2>
                <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 8 }}>
                  Drop your PDF. Indexing starts automatically — we chunk, extract chapters, tag page numbers, and store vectors in Postgres.
                </p>
              </div>

              {uploading ? (
                <div className="circular-loader" style={{ padding: '30px 0' }}>
                  <svg width="72" height="72" className="progress-ring">
                    <circle stroke="rgba(255,255,255,0.03)" strokeWidth="6" fill="transparent" r="30" cx="36" cy="36" />
                    <circle
                      stroke="var(--accent)"
                      strokeWidth="6"
                      strokeDasharray="188.4 188.4"
                      strokeDashoffset={188.4 - (uploadProgress / 100) * 188.4}
                      strokeLinecap="round"
                      fill="transparent"
                      r="30"
                      cx="36"
                      cy="36"
                      className="progress-ring-circle"
                      style={{ filter: 'drop-shadow(0 0 6px var(--accent-glow))' }}
                    />
                  </svg>
                  <div className="loader-msg" style={{ fontSize: 16, color: 'var(--accent)', fontWeight: 600 }}>
                    {uploadProgress}%
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--fg-muted)', textAlign: 'center' }}>{uploadStep}</div>
                </div>
              ) : (
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
                    handleFileSelect(e.dataTransfer.files?.[0] ?? null);
                  }}
                >
                  <div className="drop-icon" style={{ fontSize: 40 }}>
                    📄
                  </div>
                  <div className="file-name">Drop PDF here or click to browse</div>
                  <div className="hint">Supports files up to 20 MB</div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf"
                    style={{ display: 'none' }}
                    onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
                  />
                </div>
              )}

              {uploadMsg && (
                <div className={`status-toast ${uploadMsg.ok ? 'success' : 'error'}`} style={{ marginTop: 20 }}>
                  {uploadMsg.text}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="tabs-nav">
              <button className={`tab-btn${activeTab === 'chat' ? ' active' : ''}`} onClick={() => setActiveTab('chat')}>
                Conversational RAG
              </button>
              <button className={`tab-btn${activeTab === 'dashboard' ? ' active' : ''}`} onClick={() => setActiveTab('dashboard')}>
                Observability & Evaluation
              </button>
            </div>

            {/* Chat */}
            {activeTab === 'chat' && (
              <div className="card chat-pane">
                <div className="chat-messages">
                  {messages.length === 0 && !asking && (
                    <div style={{ color: 'var(--fg-muted)', fontSize: 13, textAlign: 'center', margin: 'auto' }}>
                      {activeSession ? 'Ask a question to query your indexed documents.' : 'Start a new chat to begin.'}
                    </div>
                  )}
                  {messages.map((msg, index) => (
                    <div key={index} className={`message-bubble ${msg.role}`}>
                      <div className={`message-sender ${msg.role}`}>{msg.role === 'user' ? 'You' : 'Assistant'}</div>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>

                      {msg.sources && msg.sources.length > 0 && (
                        <div className="citations-wrapper">
                          <div className="citations-title">
                            <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                            </svg>
                            Sources & Citations
                          </div>
                          <div className="citations-list">
                            {msg.sources.map((src, srcIdx) => {
                              const key = `${index}-${srcIdx}`;
                              const isOpen = openCitationIdx === key;
                              return (
                                <div className="citation-item" key={srcIdx}>
                                  <div className="citation-header" onClick={() => setOpenCitationIdx(isOpen ? null : key)}>
                                    <span>
                                      [{srcIdx + 1}] {src.filename} — {src.chapter} (Page {src.page})
                                    </span>
                                    <span>{isOpen ? '▼' : '►'}</span>
                                  </div>
                                  {isOpen && (
                                    <div className="citation-body">
                                      {src.snippet}...
                                      <div style={{ marginTop: 6, fontSize: 10, color: 'var(--accent)', textAlign: 'right' }}>
                                        Similarity Distance: {src.distance.toFixed(4)}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  {asking && (
                    <div className="message-bubble assistant">
                      <div className="message-sender assistant">Assistant</div>
                      <div className="typing-indicator">
                        <div className="typing-dot" />
                        <div className="typing-dot" />
                        <div className="typing-dot" />
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Input bar */}
                <div className="chat-input-wrapper">
                  <input
                    type="text"
                    placeholder={filters.document ? `Ask "${filters.document}"...` : 'Ask anything about your indexed documents...'}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAsk();
                    }}
                    disabled={asking}
                  />
                  <button className="send-btn" onClick={handleAsk} disabled={!question.trim() || asking}>
                    <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {/* Dashboard */}
            {activeTab === 'dashboard' && (
              <div className="eval-dashboard">
                {latestEval ? (
                  <>
                    <div className="dashboard-summary">
                      <svg width="18" height="18" fill="none" stroke="var(--accent)" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
                        <path d="m9 12 2 2 4-4" />
                      </svg>
                      <div>
                        Showing LLM-Judge metrics (Ragas/DeepEval format) evaluated on your last query:{' '}
                        <span style={{ color: 'var(--fg)', fontWeight: 600 }}>&quot;{latestQuestion}&quot;</span>
                      </div>
                    </div>
                    <div className="eval-grid">
                      {renderGauge(latestEval.faithfulness, 'Faithfulness', 'Is the answer grounded ONLY in the retrieved chunks?', latestEval.reasonings.faithfulness)}
                      {renderGauge(latestEval.answer_relevance, 'Answer Relevance', 'Does the answer directly address the user question?', latestEval.reasonings.answer_relevance)}
                      {renderGauge(latestEval.context_precision, 'Context Precision', 'Are the retrieved chunks placed at high ranks?', latestEval.reasonings.context_precision)}
                      {renderGauge(latestEval.context_recall, 'Context Recall', 'Does the context contain all points of the answer?', latestEval.reasonings.context_recall)}
                    </div>
                  </>
                ) : (
                  <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--fg-muted)' }}>
                    <svg width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" style={{ margin: '0 auto 16px', opacity: 0.3 }}>
                      <path d="M20 20H4V4M4 16l6-6 4 4 6-6" />
                    </svg>
                    <h3 style={{ color: 'var(--fg)', marginBottom: 8 }}>Observability Metrics Empty</h3>
                    <p style={{ fontSize: 13 }}>
                      Ask a question in the Conversational RAG tab to trigger the RAGAS/DeepEval LLM-Judge evaluation in real-time.
                    </p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

      <footer className="footer">
        Advanced RAG Observability Dashboard · Built with Python FastAPI · pgvector · Next.js 16
      </footer>
    </div>
  );
}
