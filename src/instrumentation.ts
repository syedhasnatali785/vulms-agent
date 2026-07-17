/**
 * Next.js Instrumentation Hook
 * Called ONCE when the Next.js server process starts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Dynamically import the Node-only cron modules to prevent edge compiler warnings
    const { startCron } = await import('./lib/cron');
    await startCron();
  }
}
