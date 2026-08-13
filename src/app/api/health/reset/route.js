import { NextResponse } from "next/server";
import { resetHealth, clearAllHealth } from "open-sse/services/healthTracker.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * GET /api/health/reset
 * 
 * Reset health tracker:
 * - ?model=xxx  → reset specific model
 * - (no param)  → clear all health state
 * 
 * Useful when models are stuck in circuit OPEN state
 * and need to be retried immediately.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const model = searchParams.get("model");

    if (model) {
      resetHealth(model);
      return NextResponse.json({
        ok: true,
        message: `Health reset for model: ${model}`,
        model
      }, { headers: CORS_HEADERS });
    } else {
      clearAllHealth();
      return NextResponse.json({
        ok: true,
        message: "All health state cleared"
      }, { headers: CORS_HEADERS });
    }
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error.message
    }, { status: 500, headers: CORS_HEADERS });
  }
}

/**
 * DELETE /api/health/reset
 * Same as GET — clear health state
 */
export async function DELETE(request) {
  return GET(request);
}
