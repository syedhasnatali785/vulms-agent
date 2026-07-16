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

  // Helper function to handle unique constraint violations by updating existing files
  const handleUniqueViolation = async (dataToSave: any) => {
    console.warn('Unique constraint violation, updating existing record...');
    const { data: updateData, error: updateError } = await supabase
      .from('files')
      .update(dataToSave)
      .eq('filename', filename)
      .select();
      
    if (!updateError && updateData && updateData.length > 0) {
      return updateData[0];
    }
    console.error('Error updating existing record on unique violation:', updateError);
    return null;
  };

  // Try 1: Insert all fields
  let res = await supabase.from('files').insert([insertData]).select();
  if (!res.error && res.data && res.data.length > 0) {
    return res.data[0];
  }
  
  if (res.error) {
    console.warn('Initial insert failed, error details:', res.error);
    if (res.error.code === '23505') {
      return await handleUniqueViolation(insertData);
    }
  }

  // Try 2: Drop message_id (in case message_id is missing or causing error)
  const insertData2: any = { filename, r2_key: r2Key, mime_type: mimeType, uploaded_by: uploadedBy };
  res = await supabase.from('files').insert([insertData2]).select();
  if (!res.error && res.data && res.data.length > 0) {
    return res.data[0];
  }

  if (res.error) {
    console.warn('Second insert failed, error details:', res.error);
    if (res.error.code === '23505') {
      return await handleUniqueViolation(insertData2);
    }
  }

  // Try 3: Drop uploaded_by (in case uploaded_by is missing or has foreign key constraint issues)
  const insertData3: any = { filename, r2_key: r2Key, mime_type: mimeType };
  res = await supabase.from('files').insert([insertData3]).select();
  if (!res.error && res.data && res.data.length > 0) {
    return res.data[0];
  }

  if (res.error) {
    console.error('Third insert failed, error details:', res.error);
    if (res.error.code === '23505') {
      return await handleUniqueViolation(insertData3);
    }
  }

  console.error('All metadata insertion attempts failed.');
  return null;
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
      .limit(1);
    if (data && data.length > 0 && !error) return data[0];
  }

  // 2. Try querying by message_id
  try {
    const { data, error } = await supabase
      .from('files')
      .select('id, filename, r2_key, mime_type')
      .eq('message_id', trimmed)
      .limit(1);
    if (data && data.length > 0 && !error) return data[0];
  } catch (e) {
    // message_id column might not exist in table, ignore error
  }

  // 3. Fallback to querying by filename (case insensitive partial match)
  const { data, error } = await supabase
    .from('files')
    .select('id, filename, r2_key, mime_type')
    .ilike('filename', `%${trimmed}%`)
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return data[0];
}

export function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();
  
  // 1. Extract course codes (e.g., CS101, ENG 201, MTH-301, etc.)
  const coursePattern = /\b([a-zA-Z]{2,4})\s*[-_]?\s*(\d{3})\b/gi;
  let match;
  while ((match = coursePattern.exec(text)) !== null) {
    const prefix = match[1].toLowerCase();
    const num = match[2];
    keywords.add(`${prefix}${num}`);
    keywords.add(`${prefix} ${num}`);
    keywords.add(`${prefix}-${num}`);
    keywords.add(`${prefix}_${num}`);
  }

  // 2. Extract other significant words (length >= 3, not common stop words)
  const stopWords = new Set([
    'the', 'and', 'for', 'you', 'get', 'please', 'send', 'file', 'retrieve', 
    'download', 'with', 'from', 'this', 'that', 'here', 'your', 'find', 'show', 
    'give', 'need', 'want', 'search', 'look', 'matching', 'handout', 'handouts'
  ]);
  
  const words = text.split(/[^a-zA-Z0-9_-]+/);
  for (const w of words) {
    const cleanWord = w.toLowerCase().trim();
    if (cleanWord.length >= 3 && !stopWords.has(cleanWord) && !/^\d+$/.test(cleanWord)) {
      keywords.add(cleanWord);
      if (cleanWord.includes('_') || cleanWord.includes('-')) {
        const parts = cleanWord.split(/[_-]+/);
        for (const p of parts) {
          if (p.length >= 3 && !stopWords.has(p)) {
            keywords.add(p);
          }
        }
      }
    }
  }

  return Array.from(keywords);
}

// Keep extractCourseKeywords for compatibility
export function extractCourseKeywords(text: string): string[] {
  return extractKeywords(text);
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

