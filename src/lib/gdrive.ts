import axios from 'axios';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const DRIVE_FOLDER_IDS = [
  '1zJW41VjmF7YZJU8OfE2TWMk3jXQ0okcD',
  '1iH8wcs301TR1WzdKpXOUa3XpT_hz_DRD',
  '12qgKCjOp2_18dt8JAy1gM6kezKAbWRBP', // Newly added folder containing subfolders
  '1ZCeUHM8vXczv8ye6a0jfrcNjLi9-qgS7',
  '12n1I6CucRwZ6gNHERA3BOlteVc9oFUtE'
];

export interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
}

// In-memory cache of all folder IDs (including root folders and their subfolders)
let cachedFolderIds: string[] = [];
let lastCacheUpdate = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes cache time-to-live

/**
 * Recursively fetches all subfolder IDs under the given root folder IDs.
 * Utilizes a BFS queue approach to crawl the directory structure.
 */
async function fetchAllFolderIds(): Promise<string[]> {
  if (!GOOGLE_API_KEY) return [];

  console.log('Starting recursive scan of Google Drive folders...');
  const allFolderIds = new Set<string>(DRIVE_FOLDER_IDS);
  const queue = [...DRIVE_FOLDER_IDS];

  while (queue.length > 0) {
    const parentId = queue.shift()!;
    try {
      const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
        params: {
          q,
          key: GOOGLE_API_KEY,
          fields: 'files(id)',
          pageSize: 100
        }
      });

      if (response.data?.files) {
        for (const folder of response.data.files) {
          if (!allFolderIds.has(folder.id)) {
            allFolderIds.add(folder.id);
            queue.push(folder.id); // Add to queue to search its subfolders recursively
          }
        }
      }
    } catch (error: any) {
      console.error(`Error fetching subfolders for parent folder ${parentId}:`, error.message);
    }
  }

  console.log(`Recursive scan completed. Discovered ${allFolderIds.size} total folders.`);
  return Array.from(allFolderIds);
}

/**
 * Returns the list of discovered folder IDs, refreshing from Google Drive if expired.
 */
export async function getFolderIds(): Promise<string[]> {
  const now = Date.now();
  if (cachedFolderIds.length === 0 || (now - lastCacheUpdate) > CACHE_TTL) {
    try {
      cachedFolderIds = await fetchAllFolderIds();
      lastCacheUpdate = now;
    } catch (e: any) {
      console.error('Failed to refresh Google Drive folder cache, using fallback:', e.message);
      if (cachedFolderIds.length === 0) {
        return DRIVE_FOLDER_IDS;
      }
    }
  }
  return cachedFolderIds;
}

/**
 * Searches for files in the designated public Google Drive folders (including all subfolders).
 * Case-insensitive search on filename.
 */
export async function searchGDriveFiles(query: string, contextTerms: string[] = []): Promise<GDriveFile[]> {
  if (!GOOGLE_API_KEY) {
    console.warn('GOOGLE_API_KEY is not defined in environment variables. Google Drive search bypassed.');
    return [];
  }

  const folderIds = await getFolderIds();
  if (folderIds.length === 0) return [];

  const results: GDriveFile[] = [];
  const escapedQuery = query.replace(/'/g, "\\'");

  // Chunk folder IDs into groups of 20 to avoid query string length limit issues (standard is ~2KB-8KB)
  const chunkSize = 20;
  const chunks: string[][] = [];
  for (let i = 0; i < folderIds.length; i += chunkSize) {
    chunks.push(folderIds.slice(i, i + chunkSize));
  }

  // Build the context term filters for the query string (e.g. "and name contains 'final'")
  const contextFilters = contextTerms.map(term => `and name contains '${term.replace(/'/g, "\\'")}'`).join(' ');

  // Fetch search results for each chunk in parallel to minimize response latency
  const searchPromises = chunks.map(async (folderChunk) => {
    try {
      const parentFilter = folderChunk.map(id => `'${id}' in parents`).join(' or ');
      const q = `(${parentFilter}) and name contains '${escapedQuery}' ${contextFilters} and trashed = false`;

      const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
        params: {
          q,
          key: GOOGLE_API_KEY,
          fields: 'files(id, name, mimeType)',
          pageSize: 10
        }
      });

      return response.data?.files || [];
    } catch (error: any) {
      console.error(`Error searching GDrive folder chunk:`, error.response?.data || error.message);
      return [];
    }
  });

  const chunkResults = await Promise.all(searchPromises);
  for (const files of chunkResults) {
    results.push(...files);
  }

  // Deduplicate files by ID
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
