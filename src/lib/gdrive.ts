import axios from 'axios';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const DRIVE_FOLDER_IDS = [
  '1zJW41VjmF7YZJU8OfE2TWMk3jXQ0okcD',
  '1iH8wcs301TR1WzdKpXOUa3XpT_hz_DRD',
  '12qgKCjOp2_18dt8JAy1gM6kezKAbWRBP',
  '1ZCeUHM8vXczv8ye6a0jfrcNjLi9-qgS7',
  '12n1I6CucRwZ6gNHERA3BOlteVc9oFUtE'
];

export interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
}

// In-memory cache: maps folder ID → folder name (for smart pre-filtering)
interface FolderInfo {
  id: string;
  name: string;
}
let cachedFolders: FolderInfo[] = [];
let lastCacheUpdate = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * BFS crawler that discovers ALL subfolder IDs, resolving Google Drive shortcuts
 * to their target folders. Stores folder names for smart pre-filtering at search time.
 */
async function fetchAllFolders(): Promise<FolderInfo[]> {
  if (!GOOGLE_API_KEY) return [];

  console.log('Starting recursive scan of Google Drive folders (with shortcut resolution)...');
  const allFolders = new Map<string, string>(); // id → name
  const queue = [...DRIVE_FOLDER_IDS];

  // Seed root folder names
  for (const id of DRIVE_FOLDER_IDS) {
    allFolders.set(id, ''); // names will be filled on first access
  }

  let requestCount = 0;
  const MAX_REQUESTS = 500; // Safety cap to prevent runaway crawls

  while (queue.length > 0 && requestCount < MAX_REQUESTS) {
    const parentId = queue.shift()!;
    requestCount++;
    try {
      // Fetch both real subfolders AND shortcuts in one query
      const q = `'${parentId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`;
      const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
        params: {
          q,
          key: GOOGLE_API_KEY,
          fields: 'files(id, name, mimeType, shortcutDetails)',
          pageSize: 1000
        }
      });

      if (response.data?.files) {
        for (const item of response.data.files) {
          if (item.mimeType === 'application/vnd.google-apps.folder') {
            if (!allFolders.has(item.id)) {
              allFolders.set(item.id, item.name || '');
              queue.push(item.id);
            }
          } else if (
            item.mimeType === 'application/vnd.google-apps.shortcut' &&
            item.shortcutDetails?.targetMimeType === 'application/vnd.google-apps.folder'
          ) {
            const targetId = item.shortcutDetails.targetId;
            if (!allFolders.has(targetId)) {
              // Use the shortcut's display name as the folder name
              allFolders.set(targetId, item.name || '');
              queue.push(targetId);
            }
          }
        }
      }
    } catch (error: any) {
      console.error(`Error crawling folder ${parentId}:`, error.message);
    }
  }

  const result = Array.from(allFolders.entries()).map(([id, name]) => ({ id, name }));
  console.log(`Recursive scan completed. Discovered ${result.length} total folders.`);
  return result;
}

/**
 * Returns the cached list of all discovered folders (refreshes if expired).
 */
async function getCachedFolders(): Promise<FolderInfo[]> {
  const now = Date.now();
  if (cachedFolders.length === 0 || (now - lastCacheUpdate) > CACHE_TTL) {
    try {
      cachedFolders = await fetchAllFolders();
      lastCacheUpdate = now;
    } catch (e: any) {
      console.error('Failed to refresh Google Drive folder cache:', e.message);
      if (cachedFolders.length === 0) {
        return DRIVE_FOLDER_IDS.map(id => ({ id, name: '' }));
      }
    }
  }
  return cachedFolders;
}

/**
 * Smart pre-filtering: Given a search query like "cs405", find folders whose names
 * match the query pattern (e.g. folders named "CS Subjects", "CS405", etc.)
 * Falls back to root folders if no name-based matches are found.
 */
function filterRelevantFolders(folders: FolderInfo[], query: string, contextTerms: string[]): FolderInfo[] {
  const lowerQuery = query.toLowerCase();

  // Extract subject prefix (e.g. "cs" from "cs405") and code (e.g. "405")
  const codeMatch = lowerQuery.match(/^([a-z]+)\s*(\d+)$/);
  const subjectPrefix = codeMatch ? codeMatch[1] : lowerQuery;

  const relevant = folders.filter(f => {
    const lowerName = f.name.toLowerCase();
    // Match folders whose name contains the full query, subject prefix, or context terms
    if (lowerName.includes(lowerQuery)) return true;
    if (lowerName.includes(subjectPrefix)) return true;
    for (const term of contextTerms) {
      if (lowerName.includes(term.toLowerCase())) return true;
    }
    return false;
  });

  // If we found relevant folders, use them. Otherwise fall back to ALL root folders.
  if (relevant.length > 0) {
    return relevant;
  }

  // Fallback: search only the root folders
  return DRIVE_FOLDER_IDS.map(id => ({ id, name: '' }));
}

/**
 * Searches for files in Google Drive folders.
 * 
 * KEY FIX: Queries each folder INDIVIDUALLY (not combined with 'or')
 * because Google Drive API with a public API key returns 403 on combined parent queries.
 * Uses smart pre-filtering to keep the number of API calls manageable.
 */
export async function searchGDriveFiles(query: string, contextTerms: string[] = []): Promise<GDriveFile[]> {
  if (!GOOGLE_API_KEY) {
    console.warn('GOOGLE_API_KEY is not defined. Google Drive search bypassed.');
    return [];
  }

  const allFolders = await getCachedFolders();
  if (allFolders.length === 0) return [];

  // Smart pre-filter: narrow down from 693+ folders to ~5-30 relevant ones
  const relevantFolders = filterRelevantFolders(allFolders, query, contextTerms);
  console.log(`GDrive search: "${query}" [${contextTerms.join(',')}] → searching ${relevantFolders.length} of ${allFolders.length} folders`);

  const escapedQuery = query.replace(/'/g, "\\'");
  const contextFilters = contextTerms.map(t => `and name contains '${t.replace(/'/g, "\\'")}'`).join(' ');
  const results: GDriveFile[] = [];

  // Query each folder individually (chunkSize=1) with concurrency limit of 10
  const CONCURRENCY = 10;
  for (let i = 0; i < relevantFolders.length; i += CONCURRENCY) {
    const batch = relevantFolders.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (folder) => {
      try {
        const q = `'${folder.id}' in parents and name contains '${escapedQuery}' ${contextFilters} and trashed = false`;
        const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
          params: {
            q,
            key: GOOGLE_API_KEY,
            fields: 'files(id, name, mimeType)',
            pageSize: 20
          }
        });
        return response.data?.files || [];
      } catch (error: any) {
        // Silently skip folders that throw 403 (private shortcuts)
        return [];
      }
    });

    const batchResults = await Promise.all(promises);
    for (const files of batchResults) {
      results.push(...files);
    }
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
