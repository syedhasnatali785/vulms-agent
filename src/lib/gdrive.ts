import axios from 'axios';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const DRIVE_FOLDER_IDS = [
  '1zJW41VjmF7YZJU8OfE2TWMk3jXQ0okcD',
  '1iH8wcs301TR1WzdKpXOUa3XpT_hz_DRD'
];

export interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
}

/**
 * Searches for files in the designated public Google Drive folders.
 * Case-insensitive search on filename.
 */
export async function searchGDriveFiles(query: string): Promise<GDriveFile[]> {
  if (!GOOGLE_API_KEY) {
    console.warn('GOOGLE_API_KEY is not defined in environment variables. Google Drive search bypassed.');
    return [];
  }

  const results: GDriveFile[] = [];

  for (const folderId of DRIVE_FOLDER_IDS) {
    try {
      const escapedQuery = query.replace(/'/g, "\\'");
      const q = `'${folderId}' in parents and name contains '${escapedQuery}' and trashed = false`;

      const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
        params: {
          q,
          key: GOOGLE_API_KEY,
          fields: 'files(id, name, mimeType)',
          pageSize: 10
        }
      });

      if (response.data?.files) {
        results.push(...response.data.files);
      }
    } catch (error: any) {
      console.error(`Error searching GDrive folder ${folderId} for "${query}":`, error.response?.data || error.message);
    }
  }

  // Deduplicate by file ID
  const seen = new Set<string>();
  return results.filter(file => {
    if (seen.has(file.id)) return false;
    seen.add(file.id);
    return true;
  });
}

/**
 * Downloads a file by ID from Google Drive.
 */
export async function downloadGDriveFile(fileId: string): Promise<Buffer> {
  if (!GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is missing from environment variables.');
  }

  const response = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    params: {
      alt: 'media',
      key: GOOGLE_API_KEY
    },
    responseType: 'arraybuffer'
  });

  return Buffer.from(response.data);
}
