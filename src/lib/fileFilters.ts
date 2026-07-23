/**
 * Helper to check if a filename indicates a Midterm exam/preparation file.
 * Uses token splitting + regex boundaries to catch all midterm variations.
 */
export function isMidtermFile(filename: string): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();

  // 1. Direct regex check for explicit midterm indicators anywhere in the string
  if (/midterm/i.test(lower) || /mid[-_]?terms?/i.test(lower) || /mid[-_]?paper/i.test(lower)) {
    return true;
  }

  // 2. Tokenized check to catch isolated "mid" / "mids" tokens (avoids 'pyramid', 'humidity', 'middle')
  const tokens = lower.split(/[\s_.()\[\]\-]+/);
  return tokens.some(token => token === 'mid' || token === 'midterm' || token === 'midterms' || token === 'mids');
}

/**
 * Helper to check if a filename indicates a Final term exam/preparation file.
 * Uses token splitting + regex boundaries to catch all final term variations.
 */
export function isFinalTermFile(filename: string): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();

  // 1. Direct regex check for explicit final term indicators
  if (/finalterm/i.test(lower) || /final[-_]?terms?/i.test(lower) || /final[-_]?paper/i.test(lower)) {
    return true;
  }

  // 2. Tokenized check to catch isolated "final" / "finals" tokens
  const tokens = lower.split(/[\s_.()\[\]\-]+/);
  return tokens.some(token => token === 'final' || token === 'finalterm' || token === 'finalterms' || token === 'finals');
}

/**
 * Strict Policy Function for End-Users / Students:
 * Strips out ALL midterm/mid files and ONLY allows verified final term files.
 */
export function isAllowedForStudent(filename: string): boolean {
  if (!filename) return false;
  // Rule 1: NEVER allow midterm / mid files to end users
  if (isMidtermFile(filename)) return false;
  // Rule 2: ONLY allow final term files to end users
  return isFinalTermFile(filename);
}
