import { NextResponse } from 'next/server';
import { getLogs } from '@/app/api/webhook/route';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const logs = getLogs();
    return NextResponse.json(logs, {
      headers: { 'Cache-Control': 'no-store, max-age=0' }
    });
  } catch (error: any) {
    return NextResponse.json([], { status: 200 });
  }
}
