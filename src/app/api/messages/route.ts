import { NextResponse } from 'next/server';
import { getMessages } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const messages = await getMessages(100);
    return NextResponse.json(messages, {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      },
    });
  } catch (error: any) {
    console.error('Error fetching messages in API route:', error);
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
  }
}
