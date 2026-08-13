import { NextResponse } from "next/server";
import { getPoolStats, getAvailableAccounts } from "open-sse/services/accountPoolManager.js";
import { NextRequest } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * GET /api/health/accounts?provider=antigravity
 * 
 * Returns account pool statistics for a provider:
 * - Total/available/unavailable accounts
 * - Per-account health status
 * - Rate limit status
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    
    if (!provider) {
      return NextResponse.json({
        ok: false,
        error: "Missing 'provider' query parameter"
      }, { status: 400, headers: CORS_HEADERS });
    }
    
    const stats = getPoolStats(provider);
    const available = getAvailableAccounts(provider);
    
    return NextResponse.json({
      ok: true,
      provider,
      stats,
      availableCount: available.length,
      availableAccounts: available.map(acc => acc.id)
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
