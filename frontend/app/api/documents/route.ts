import { NextResponse } from 'next/server';
import { backendBase } from '@/lib/backend';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const backendRes = await fetch(`${backendBase()}/api/documents`, {
      method: 'GET',
      cache: 'no-store',
    });

    const data = await backendRes.json().catch(() => null);
    if (!backendRes.ok) {
      const message =
        data?.detail || data?.message || backendRes.statusText || 'Request failed';
      return NextResponse.json({ message }, { status: backendRes.status });
    }
    return NextResponse.json(data);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'List documents proxy failed';
    return NextResponse.json({ message }, { status: 502 });
  }
}
