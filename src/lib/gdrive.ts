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

interface FolderInfo {
  id: string;
  name: string;
}

// In-memory cache
let cachedFolders: FolderInfo[] = [];
let lastCacheUpdate = 0;
let cacheWarmingInProgress = false;
const CACHE_TTL = 30 * 60 * 1000;

/**
 * BFS crawler: discovers ALL subfolder IDs, resolving Google Drive shortcuts.
 * Runs NON-BLOCKING in the background so it never blocks webhook responses.
 */
async function fetchAllFolders(): Promise<FolderInfo[]> {
  if (!GOOGLE_API_KEY) return [];

  console.log('[GDrive] Starting background folder scan...');
  const allFolders = new Map<string, string>();
  const queue = [...DRIVE_FOLDER_IDS];
  for (const id of DRIVE_FOLDER_IDS) allFolders.set(id, '');

  let requestCount = 0;
  const MAX_REQUESTS = 500;

  while (queue.length > 0 && requestCount < MAX_REQUESTS) {
    const parentId = queue.shift()!;
    requestCount++;
    try {
      const q = `'${parentId}' in parents and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut') and trashed = false`;
      const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
        params: { q, key: GOOGLE_API_KEY, fields: 'files(id, name, mimeType, shortcutDetails)', pageSize: 1000 }
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
              allFolders.set(targetId, item.name || '');
              queue.push(targetId);
            }
          }
        }
      }
    } catch (error: any) {
      // Silently skip inaccessible folders
    }
  }

  const result = Array.from(allFolders.entries()).map(([id, name]) => ({ id, name }));
  console.log(`[GDrive] Scan complete. ${result.length} folders discovered.`);
  return result;
}

/**
 * Starts background cache warming without blocking the caller.
 * This is the KEY FIX: the webhook never waits for this.
 */
function startBackgroundCacheWarm() {
  if (cacheWarmingInProgress) return;
  cacheWarmingInProgress = true;
  fetchAllFolders()
    .then(folders => {
      cachedFolders = folders;
      lastCacheUpdate = Date.now();
      console.log(`[GDrive] Cache warmed with ${folders.length} folders.`);
    })
    .catch(e => console.error('[GDrive] Background cache warm failed:', e.message))
    .finally(() => { cacheWarmingInProgress = false; });
}

/**
 * Returns cached folders. If cache is empty/expired, starts background warming
 * and returns ROOT folders immediately so the webhook can still function.
 */
function getAvailableFolders(): FolderInfo[] {
  const now = Date.now();
  if (cachedFolders.length === 0 || (now - lastCacheUpdate) > CACHE_TTL) {
    startBackgroundCacheWarm();
  }
  // If cache is populated, use it. Otherwise fall back to root folders.
  if (cachedFolders.length > 0) return cachedFolders;
  return DRIVE_FOLDER_IDS.map(id => ({ id, name: '' }));
}

/**
 * Smart pre-filtering: narrow down folders by name relevance.
 */
function filterRelevantFolders(folders: FolderInfo[], query: string, contextTerms: string[]): FolderInfo[] {
  const lowerQuery = query.toLowerCase();
  const codeMatch = lowerQuery.match(/^([a-z]+)\s*(\d+)$/);
  const subjectPrefix = codeMatch ? codeMatch[1] : lowerQuery;
  const fullCode = codeMatch ? `${codeMatch[1]}${codeMatch[2]}` : lowerQuery;

  const relevant = folders.filter(f => {
    const n = f.name.toLowerCase();
    if (n.includes(fullCode)) return true;
    if (n.includes(subjectPrefix)) return true;
    if (n.includes(lowerQuery)) return true;
    for (const t of contextTerms) { if (n.includes(t.toLowerCase())) return true; }
    return false;
  });

  return relevant.length > 0 ? relevant : DRIVE_FOLDER_IDS.map(id => ({ id, name: '' }));
}

/**
 * Searches Google Drive. Queries each folder INDIVIDUALLY (not combined with 'or')
 * because public API keys get 403 on combined parent queries.
 */
export async function searchGDriveFiles(query: string, contextTerms: string[] = []): Promise<GDriveFile[]> {
  if (!GOOGLE_API_KEY) return [];

  const allFolders = getAvailableFolders(); // NON-BLOCKING
  if (allFolders.length === 0) return [];

  const relevantFolders = filterRelevantFolders(allFolders, query, contextTerms);
  console.log(`[GDrive] Search "${query}" [${contextTerms}] → ${relevantFolders.length}/${allFolders.length} folders`);

  const escapedQuery = query.replace(/'/g, "\\'");
  
  // Build the context term filters for the query string using OR grouping
  // Example: and (name contains 'finale' or name contains 'final')
  let contextFilters = '';
  if (contextTerms.length > 0) {
    const inner = contextTerms.map(term => `name contains '${term.replace(/'/g, "\\'")}'`).join(' or ');
    contextFilters = `and (${inner})`;
  }

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
  } const seen = new Set<string>();
  return results.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });
}

export async function downloadGDriveFile(fileId: string): Promise<Buffer> {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY missing');
  const response = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    params: { alt: 'media', key: GOOGLE_API_KEY }, responseType: 'arraybuffer'
  });
  return Buffer.from(response.data);
}
