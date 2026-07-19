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

  // Try 2: Drop message_id (in case message_id column is missing)
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

  // Try 3: Drop uploaded_by (in case uploaded_by has foreign key constraint issues)
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
    .ilike('filename', `%${filename}%`)
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return data[0];
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

/**
 * Extracts course codes from text.
 * Matches patterns like: ENG201, eng 201, ENG-201, eng_201, CS 101, mth301
 * Returns multiple format variants so DB ilike can match filenames like "ENG201_Handouts_Final.pdf"
 * 
 * IMPORTANT: This only extracts course codes, NOT random English words.
 * Random word extraction caused false-positive file matches on every message.
 */
export function extractCourseKeywords(text: string): string[] {
  const coursePattern = /\b([a-zA-Z]{2,5})\s*[-_]?\s*(\d{2,4})\b/gi;
  const keywords = new Set<string>();
  let match;
  while ((match = coursePattern.exec(text)) !== null) {
    const prefix = match[1].toLowerCase();
    const num = match[2];
    // Add all format variants so ilike can match any naming convention
    keywords.add(`${prefix}${num}`);       // eng201
    keywords.add(`${prefix} ${num}`);      // eng 201
    keywords.add(`${prefix}-${num}`);      // eng-201
    keywords.add(`${prefix}_${num}`);      // eng_201
    keywords.add(`${prefix.toUpperCase()}${num}`);   // ENG201
    keywords.add(`${prefix.toUpperCase()}_${num}`);  // ENG_201
  }
  return Array.from(keywords);
}

// Alias for backward compatibility
export function extractKeywords(text: string): string[] {
  return extractCourseKeywords(text);
}

export async function getFilesByKeywords(keywords: string[], contextTerms: string[] = []) {
  if (keywords.length === 0) return [];

  const queries = keywords.map(keyword => {
    let query = supabase
      .from('files')
      .select('id, filename, r2_key, mime_type')
      .ilike('filename', `%${keyword}%`);

    if (contextTerms.length > 0) {
      // Build an OR filter string: filename.ilike.%term1%,filename.ilike.%term2%
      const orFilter = contextTerms.map(term => `filename.ilike.%${term}%`).join(',');
      query = query.or(orFilter);
    }
    return query;
  });

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

export async function saveMessage(sender: string, text: string, direction: 'incoming' | 'outgoing') {
  try {
    const { data, error } = await supabase
      .from('messages')
      .insert([{ sender, text, direction }])
      .select();
    
    if (error) {
      console.error('Error saving message in Supabase (make sure the messages table is created):', error);
      return null;
    }
    return data?.[0] || null;
  } catch (err) {
    console.error('Exception saving message in Supabase:', err);
    return null;
  }
}

export async function getMessages(limit = 100) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
      
    if (error) {
      console.error('Error fetching messages from Supabase:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('Exception fetching messages from Supabase:', err);
    return [];
  }
}

export async function saveLog(level: 'info' | 'warn' | 'error', message: string) {
  try {
    const { error } = await supabase
      .from('logs')
      .insert([{ level, message }]);
    if (error) {
      // Table might not exist, log to console
      console.log(`[Supabase Log Fallback] [${level.toUpperCase()}] ${message}`);
    }
  } catch (err) {
    console.log(`[Supabase Log Exception] [${level.toUpperCase()}] ${message}`);
  }
}

export async function getLogsDb(limit = 100) {
  try {
    const { data, error } = await supabase
      .from('logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  } catch (err) {
    return [];
  }
}

export async function getUniqueStudents(): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('sender')
      .eq('direction', 'incoming');
    if (error || !data) return [];
    
    // Deduplicate in JS to avoid complexity with distinct select statements
    const senders = data.map((m: any) => m.sender).filter(Boolean);
    return Array.from(new Set(senders));
  } catch (err) {
    console.error('Exception fetching unique students:', err);
    return [];
  }
}

