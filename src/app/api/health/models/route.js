import { NextResponse } from "next/server";
import { getAllHealthStatuses, getHealthSummary } from "open-sse/services/healthTracker.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * GET /api/health/models
 * 
 * Returns health status of all tracked models:
 * - Circuit breaker state
 * - Latency percentiles (P50, P95)
 * - Success/failure rate
 * - Rate limit status
 */
export async function GET() {
  try {
    const statuses = getAllHealthStatuses();
    const summary = getHealthSummary();
    
    return NextResponse.json({
      ok: true,
      summary,
      models: statuses
    }, { headers: CORS_HEADERS });
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
