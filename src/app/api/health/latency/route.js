import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// In-memory latency history (last 100 data points per provider)
const latencyHistory = new Map();
const MAX_HISTORY = 100;

/**
 * GET /api/health/latency
 * 
 * Returns latency history for all providers:
 * - Per-provider latency samples (timestamp, latencyMs, success)
 * - Summary statistics (avg, p50, p95, p99)
 */
export async function GET() {
  try {
    const providers = Array.from(latencyHistory.entries()).map(([providerId, samples]) => {
      const latencies = samples.filter(s => s.success).map(s => s.latencyMs);
      const sorted = [...latencies].sort((a, b) => a - b);
      
      return {
        providerId,
        sampleCount: samples.length,
        successCount: latencies.length,
        failureCount: samples.length - latencies.length,
        stats: {
          avg: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
          min: sorted.length > 0 ? sorted[0] : 0,
          max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
          p50: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0,
          p95: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0,
          p99: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.99)] : 0,
        },
        history: samples.slice(-50), // Last 50 samples for graph
      };
    });
    
    return NextResponse.json({
      ok: true,
      providers,
      totalProviders: providers.length,
    }, { headers: CORS_HEADERS });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error.message
    }, { status: 500, headers: CORS_HEADERS });
  }
}

/**
 * POST /api/health/latency
 * 
 * Record a latency sample for a provider:
 * Body: { providerId: string, latencyMs: number, success: boolean }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { providerId, latencyMs, success = true } = body;
    
    if (!providerId || typeof latencyMs !== "number") {
      return NextResponse.json({
        ok: false,
        error: "Missing 'providerId' or 'latencyMs'"
      }, { status: 400, headers: CORS_HEADERS });
    }
    
    if (!latencyHistory.has(providerId)) {
      latencyHistory.set(providerId, []);
    }
    
    const samples = latencyHistory.get(providerId);
    samples.push({
      timestamp: Date.now(),
      latencyMs,
      success,
    });
    
    // Trim to max history
    if (samples.length > MAX_HISTORY) {
      samples.splice(0, samples.length - MAX_HISTORY);
    }
    
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error.message
    }, { status: 500, headers: CORS_HEADERS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
