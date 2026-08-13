import { NextResponse } from "next/server";
import { updateProviderConnection, getProviderConnections } from "@/lib/localDb";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * POST /api/health/reset-account
 * 
 * Reset health state for a specific account:
 * - Clears all modelLock_* fields
 * - Resets testStatus to active
 * - Clears lastError and errorCode
 * - Resets backoffLevel to 0
 * 
 * Body: { connectionId: string, provider?: string }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { connectionId, provider } = body;
    
    if (!connectionId) {
      return NextResponse.json({
        ok: false,
        error: "Missing 'connectionId' in request body"
      }, { status: 400, headers: CORS_HEADERS });
    }
    
    // Find the connection to verify it exists
    let connection = null;
    if (provider) {
      const connections = await getProviderConnections({ provider });
      connection = connections.find(c => c.id === connectionId);
    }
    
    // Build the update object to clear all health state
    const updateObj = {
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      errorCode: null,
      backoffLevel: 0,
    };
    
    // Clear all modelLock_* fields
    if (connection) {
      const lockKeys = Object.keys(connection).filter(k => k.startsWith("modelLock_"));
      for (const key of lockKeys) {
        updateObj[key] = null;
      }
    }
    
    // Apply the update
    await updateProviderConnection(connectionId, updateObj);
    
    return NextResponse.json({
      ok: true,
      message: `Health state cleared for account ${connectionId}`,
      connectionId,
      clearedFields: Object.keys(updateObj)
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
