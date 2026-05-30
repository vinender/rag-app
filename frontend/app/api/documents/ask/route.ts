import { NextRequest, NextResponse } from 'next/server';
import { backendBase } from '@/lib/backend';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const backendRes = await fetch(`${backendBase()}/api/documents/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await backendRes.json().catch(() => null);
    if (!backendRes.ok) {
      const message =
        data?.detail || data?.message || backendRes.statusText || 'Request failed';
      return NextResponse.json({ message }, { status: backendRes.status });
    }
    return NextResponse.json(data);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Ask proxy failed';
    return NextResponse.json({ message }, { status: 502 });
  }
}
