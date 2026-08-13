import { NextResponse } from "next/server";
import { getProviderConnections, getProviderNodes } from "@/lib/localDb";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * GET /api/health/all-accounts
 * 
 * Returns health status of ALL accounts across ALL providers:
 * - Provider name
 * - Account status (active, unavailable, etc.)
 * - Lock status (global lock, model lock)
 * - Last error
 * - Cooldown timer
 */
export async function GET() {
  try {
    // Get all provider nodes
    const providers = await getProviderNodes();
    const result = {};
    
    for (const provider of providers) {
      try {
        const connections = await getProviderConnections({ provider: provider.id });
        if (!connections || connections.length === 0) continue;
        
        const accounts = connections.map(conn => {
          const now = Date.now();
          
          // Check for global lock (modelLock___all)
          const globalLockExpiry = conn['modelLock___all'];
          const isGlobalLocked = globalLockExpiry && new Date(globalLockExpiry).getTime() > now;
          
          // Check for model-specific locks
          const modelLocks = Object.entries(conn)
            .filter(([k]) => k.startsWith('modelLock_') && k !== 'modelLock___all')
            .filter(([, v]) => v && new Date(v).getTime() > now);
          
          // Calculate cooldown time
          let cooldownMs = 0;
          if (isGlobalLocked) {
            cooldownMs = new Date(globalLockExpiry).getTime() - now;
          } else if (modelLocks.length > 0) {
            const earliest = modelLocks
              .map(([, v]) => new Date(v).getTime() - now)
              .filter(t => t > 0)
              .sort((a, b) => a - b)[0];
            if (earliest) cooldownMs = earliest;
          }
          
          return {
            id: conn.id,
            name: conn.displayName || conn.name || conn.email || conn.id?.slice(0, 8),
            isActive: conn.isActive !== false,
            testStatus: conn.testStatus || 'unknown',
            isGlobalLocked,
            modelLockCount: modelLocks.length,
            cooldownMs,
            cooldownHuman: formatCooldown(cooldownMs),
            lastError: conn.lastError || null,
            lastErrorAt: conn.lastErrorAt || null,
            errorCode: conn.errorCode || null,
            priority: conn.priority || 0,
            backoffLevel: conn.backoffLevel || 0,
          };
        });
        
        result[provider.id] = {
          name: provider.name || provider.id,
          totalAccounts: accounts.length,
          activeAccounts: accounts.filter(a => a.isActive && !a.isGlobalLocked && a.modelLockCount === 0).length,
          lockedAccounts: accounts.filter(a => a.isGlobalLocked || a.modelLockCount > 0).length,
          disabledAccounts: accounts.filter(a => !a.isActive).length,
          accounts,
        };
      } catch (e) {
        // Skip providers that fail
        result[provider.id] = { name: provider.name || provider.id, error: e.message };
      }
    }
    
    return NextResponse.json({
      ok: true,
      providers: result,
      summary: {
        totalProviders: Object.keys(result).length,
        totalAccounts: Object.values(result).reduce((sum, p) => sum + (p.totalAccounts || 0), 0),
        activeAccounts: Object.values(result).reduce((sum, p) => sum + (p.activeAccounts || 0), 0),
        lockedAccounts: Object.values(result).reduce((sum, p) => sum + (p.lockedAccounts || 0), 0),
      }
    }, { headers: CORS_HEADERS });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error.message
    }, { status: 500, headers: CORS_HEADERS });
  }
}

function formatCooldown(ms) {
  if (ms <= 0) return '';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
