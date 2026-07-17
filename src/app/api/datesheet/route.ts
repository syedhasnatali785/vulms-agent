import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
  const filePath = path.join(process.cwd(), 'scratch', 'datesheet_state.json');
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return NextResponse.json(data, {
        headers: { 'Cache-Control': 'no-store, max-age=0' }
      });
    }
  } catch (error) {
    // Fall through
  }

  return NextResponse.json({
    status: 'not_launched',
    lastChecked: null,
    totalNotified: 0
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' }
  });
}
