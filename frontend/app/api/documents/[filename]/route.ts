import { NextRequest, NextResponse } from 'next/server';
import { backendBase } from '@/lib/backend';

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ filename: string }>;
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { filename } = await params;
    const backendRes = await fetch(
      `${backendBase()}/api/documents/${encodeURIComponent(filename)}`,
      { method: 'DELETE' },
    );

    const data = await backendRes.json().catch(() => null);
    if (!backendRes.ok) {
      const message =
        data?.detail || data?.message || backendRes.statusText || 'Request failed';
      return NextResponse.json({ message }, { status: backendRes.status });
    }
    return NextResponse.json(data);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Delete document proxy failed';
    return NextResponse.json({ message }, { status: 502 });
  }
}
