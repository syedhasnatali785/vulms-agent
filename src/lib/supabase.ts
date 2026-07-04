import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Use service role key to bypass RLS in the server environment
export const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

export async function saveFileMetadata(filename: string, r2Key: string, mimeType: string, uploadedBy: string) {
  const { data, error } = await supabase
    .from('files')
    .insert([{ filename, r2_key: r2Key, mime_type: mimeType, uploaded_by: uploadedBy }])
    .select();
    
  if (error) {
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
    .select('r2_key, mime_type')
    .ilike('filename', `%${filename}%`) // Case insensitive partial match
    .limit(1)
    .single();
    
  if (error) return null;
  return data;
}
