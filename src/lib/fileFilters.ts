/**
 * Helper to check if a filename indicates a Midterm exam/preparation file.
 * We split the filename into tokens by common separators (spaces, underscores, hyphens, periods, etc.)
 * to avoid matching substrings like "mid" in "pyramid" or "humidity".
 */
export function isMidtermFile(filename: string): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  const tokens = lower.split(/[\s_.()\[\]\-]+/);
  return tokens.some(token => token === 'mid' || token === 'midterm' || token === 'midterms' || token === 'mids');
}

/**
 * Helper to check if a filename indicates a Final term exam/preparation file.
 * We split the filename into tokens by common separators.
 */
export function isFinalTermFile(filename: string): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  const tokens = lower.split(/[\s_.()\[\]\-]+/);
  return tokens.some(token => token === 'final' || token === 'finalterm' || token === 'finalterms' || token === 'finals');
}
