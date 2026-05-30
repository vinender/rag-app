import { NextRequest, NextResponse } from 'next/server';
import { backendBase } from '@/lib/backend';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const backendRes = await fetch(`${backendBase()}/api/documents/upload`, {
      method: 'POST',
      body: form,
    });

    const data = await backendRes.json().catch(() => null);
    if (!backendRes.ok) {
      const message =
        data?.detail || data?.message || backendRes.statusText || 'Upload failed';
      return NextResponse.json({ message }, { status: backendRes.status });
    }
    return NextResponse.json(data);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Upload proxy failed';
    return NextResponse.json({ message }, { status: 502 });
  }
}
