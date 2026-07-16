import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Use service role key to bypass RLS in the server environment.
// Fall back to a Proxy during build-time (or when variables are missing) to avoid crashing compilation.
export const supabase = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey)
  : new Proxy({} as any, {
    get(target, prop) {
      throw new Error(
        `Supabase client was accessed but environment variables (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) are missing.`
      );
    }
  });

export async function isAdmin(phoneNumber: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('users')
    .select('is_admin')
    .eq('phone_number', phoneNumber)
    .single();

  if (error || !data) return false;
  return data.is_admin === true;
}

export async function addAdmin(newAdminNumber: string, addedBy: string): Promise<boolean> {
  const { error } = await supabase
    .from('users')
    .upsert({
      phone_number: newAdminNumber,
      is_admin: true,
      // optional: track who added them
    });

  return !error;
}

export async function saveFileMetadata(filename: string, r2Key: string, mimeType: string, uploadedBy: string, messageId?: string) {
  const insertData: any = { filename, r2_key: r2Key, mime_type: mimeType, uploaded_by: uploadedBy };
  if (messageId) {
    insertData.message_id = messageId;
  }

  const { data, error } = await supabase
    .from('files')
    .insert([insertData])
    .select();

  if (error) {
    // If it failed because message_id column doesn't exist (code 42703 or message indicates it)
    if (error.code === '42703' || error.message?.includes('column "message_id"')) {
      console.warn('message_id column does not exist in files table, falling back...');
      const { data: fallbackData, error: fallbackError } = await supabase
        .from('files')
        .insert([{ filename, r2_key: r2Key, mime_type: mimeType, uploaded_by: uploadedBy }])
        .select();

      if (fallbackError) {
        console.error('Error saving file metadata (fallback):', fallbackError);
        return null;
      }
      return fallbackData[0];
    }

    console.error('Error saving file metadata:', error);
    return null;
  }
  return data[0];
}

export async function getAvailableFiles() {
  const { data, error } = await supabase
    .from('files')
    .select('id, filename, r2_key, mime_type');

  if (error) return [];
  return data;
}

export async function getFileByName(filename: string) {
  const { data, error } = await supabase
    .from('files')
    .select('id, filename, r2_key, mime_type')
    .ilike('filename', `%${filename}%`) // Case insensitive partial match
    .limit(1)
    .single();

  if (error) return null;
  return data;
}

export async function getFileByIdOrNameOrMessageId(query: string) {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // 1. Try querying by database ID (integer)
  const idNum = parseInt(trimmed, 10);
  if (!isNaN(idNum) && String(idNum) === trimmed) {
    const { data, error } = await supabase
      .from('files')
      .select('id, filename, r2_key, mime_type')
      .eq('id', idNum)
      .single();
    if (data && !error) return data;
  }

  // 2. Try querying by message_id
  try {
    const { data, error } = await supabase
      .from('files')
      .select('id, filename, r2_key, mime_type')
      .eq('message_id', trimmed)
      .single();
    if (data && !error) return data;
  } catch (e) {
    // message_id column might not exist in table, ignore error
  }

  // 3. Fallback to querying by filename (case insensitive partial match)
  const { data, error } = await supabase
    .from('files')
    .select('id, filename, r2_key, mime_type')
    .ilike('filename', `%${trimmed}%`)
    .limit(1)
    .single();

  if (error) return null;
  return data;
}

export function extractCourseKeywords(text: string): string[] {
  const pattern = /\b([a-zA-Z]{2,4})\s*-?\s*(\d{3})\b/gi;
  const keywords = new Set<string>();
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1].toLowerCase();
    const num = match[2];
    keywords.add(`${prefix}${num}`);
    keywords.add(`${prefix} ${num}`);
    keywords.add(`${prefix}-${num}`);
  }
  return Array.from(keywords);
}

export async function getFilesByKeywords(keywords: string[]) {
  if (keywords.length === 0) return [];

  const queries = keywords.map(keyword =>
    supabase
      .from('files')
      .select('id, filename, r2_key, mime_type')
      .ilike('filename', `%${keyword}%`)
  );

  const results = await Promise.all(queries);
  const allFiles: any[] = [];
  const seenIds = new Set();

  for (const res of results) {
    if (res.data) {
      for (const file of res.data) {
        if (!seenIds.has(file.id)) {
          seenIds.add(file.id);
          allFiles.push(file);
        }
      }
    }
  }
  return allFiles;
}

