import { NextRequest, NextResponse } from 'next/server';
import { ask } from '@/lib/rag';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const question = typeof body?.question === 'string' ? body.question : '';

    if (!question.trim()) {
      return NextResponse.json({ message: 'Question is required' }, { status: 400 });
    }
    if (question.length > 2000) {
      return NextResponse.json(
        { message: 'Question must be 2000 characters or fewer' },
        { status: 400 },
      );
    }

    const result = await ask(question);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Request failed';
    return NextResponse.json({ message }, { status: 500 });
  }
}
