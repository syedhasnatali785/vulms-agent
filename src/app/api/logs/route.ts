import { NextResponse } from 'next/server';
import { getLogs } from '@/app/api/webhook/route';

import { getLogsDb } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // 1. Attempt to retrieve logs from Supabase table
    const dbLogs = await getLogsDb(100);
    
    // Format database logs structure if found
    if (dbLogs && dbLogs.length > 0) {
      const formatted = dbLogs.map((l: any) => ({
        timestamp: l.created_at,
        level: l.level,
        message: l.message
      }));
      return NextResponse.json(formatted, {
        headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' }
      });
    }

    // 2. Fall back to in-memory logs buffer
    const logs = getLogs();
    return NextResponse.json(logs, {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' }
    });
  } catch (error: any) {
    return NextResponse.json([], { status: 200 });
  }
}
