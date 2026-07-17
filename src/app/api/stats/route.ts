import { NextResponse } from 'next/server';
import os from 'os';

export const dynamic = 'force-dynamic';

// Helper to calculate active CPU usage over a 100ms interval
function getCpuUsage(): Promise<number> {
  return new Promise((resolve) => {
    const startMeasure = cpuAverage();
    
    setTimeout(() => {
      const endMeasure = cpuAverage();
      const idleDifference = endMeasure.idle - startMeasure.idle;
      const totalDifference = endMeasure.total - startMeasure.total;
      
      const percentageCPU = 100 - Math.round((100 * idleDifference) / totalDifference);
      resolve(percentageCPU);
    }, 100);
  });
}

function cpuAverage() {
  const cpus = os.cpus();
  let idleMs = 0;
  let totalMs = 0;
  
  cpus.forEach((core) => {
    for (const type in core.times) {
      totalMs += (core.times as any)[type];
    }
    idleMs += core.times.idle;
  });
  
  return {
    idle: idleMs / cpus.length,
    total: totalMs / cpus.length
  };
}

export async function GET() {
  try {
    const cpuUsage = await getCpuUsage();
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const memUsage = Math.round(((totalMem - freeMem) / totalMem) * 100);
    
    return NextResponse.json({
      cpuUsage,
      cpuModel: os.cpus()[0]?.model || 'Unknown',
      cpuCores: os.cpus().length,
      loadAvg: os.loadavg(), // load averages for 1, 5, and 15 mins
      freeMem,
      totalMem,
      memUsage,
      uptime: os.uptime(),
      processUptime: process.uptime(),
      platform: os.platform(),
      arch: os.arch()
    }, {
      headers: {
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
      }
    });
  } catch (error: any) {
    console.error('Error generating system stats:', error);
    return NextResponse.json({ error: 'Failed to retrieve stats' }, { status: 500 });
  }
}
