export async function startCron() {
  // Avoid running during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    console.log('[Cron] Skipping initialization during production build phase.');
    return;
  }

  console.log('[Cron] Datesheet checking module is disabled for now.');
}
