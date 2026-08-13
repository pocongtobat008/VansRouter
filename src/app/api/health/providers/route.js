import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { getAllCircuitBreakerStatuses } from "open-sse/utils/circuitBreaker.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * GET /api/health/providers
 *
 * Per-provider breaker summary:
 * - total / active / locked accounts (locked = any modelLock_* still active)
 * - earliestRetryAfter: when the first locked account becomes available again
 * - circuit breaker state for the provider (CLOSED / DEGRADED / OPEN / HALF_OPEN)
 *
 * Lets the dashboard answer: "which providers are usable right now, how many
 * accounts are resting, and when will the next one wake up?"
 */
export async function GET() {
  try {
    // Enumerate providers from the connections table so the endpoint reflects
    // every provider that actually has accounts (not just registered nodes).
    const providerRows = await listProviderIdsWithConnections();
    const breakerStates = getAllCircuitBreakerStatuses();

    const result = {};

    for (const providerId of providerRows) {
      try {
        const connections = await getProviderConnections({ provider: providerId });
        if (!connections || connections.length === 0) continue;
        const provider = { id: providerId, name: providerId };

        const now = Date.now();
        let lockedAccounts = 0;
        let activeAccounts = 0;
        let earliestRetry = null;
        let totalAccounts = connections.length;

        for (const conn of connections) {
          const lockExpiries = Object.entries(conn)
            .filter(([k]) => k.startsWith("modelLock_"))
            .map(([, v]) => (v ? new Date(v).getTime() : 0))
            .filter((t) => t > now);

          const isLocked = lockExpiries.length > 0;
          if (isLocked) {
            lockedAccounts++;
            const earliest = Math.min(...lockExpiries);
            if (!earliestRetry || earliest < earliestRetry) earliestRetry = earliest;
          } else if (conn.isActive !== false) {
            activeAccounts++;
          }
        }

        // Match provider-level circuit breaker (named `${provider}:${proxyHash}` or bare `${provider}`)
        const providerBreakers = breakerStates
          .filter((b) => b.name === provider.id || b.name.startsWith(`${provider.id}:`))
          .map((b) => ({
            name: b.name,
            state: b.state,
            failureCount: b.failureCount,
            retryAfterMs: b.retryAfterMs || 0,
          }));
        const anyOpen = providerBreakers.some((b) => b.state === "OPEN");

        result[provider.id] = {
          name: provider.name || provider.id,
          totalAccounts,
          activeAccounts,
          lockedAccounts,
          disabledAccounts: totalAccounts - activeAccounts - lockedAccounts,
          earliestRetryAfter: earliestRetry ? new Date(earliestRetry).toISOString() : null,
          retryAfterHuman: earliestRetry ? formatCooldown(earliestRetry - now) : "",
          circuitBreaker: providerBreakers,
          breakerState: anyOpen
            ? "OPEN"
            : providerBreakers.some((b) => b.state === "HALF_OPEN")
              ? "HALF_OPEN"
              : providerBreakers.some((b) => b.state === "DEGRADED")
                ? "DEGRADED"
                : "CLOSED",
        };
      } catch (e) {
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
        openBreakers: Object.values(result).filter((p) => p.breakerState === "OPEN").length,
      },
    }, { headers: CORS_HEADERS });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error.message,
    }, { status: 500, headers: CORS_HEADERS });
  }
}

/**
 * List every provider id that has at least one connection row.
 * Uses an unfiltered read so the dashboard covers ALL configured providers,
 * not just those registered as nodes.
 */
async function listProviderIdsWithConnections() {
  const all = await getProviderConnections();
  return Array.from(new Set(all.map((c) => c.provider).filter(Boolean))).sort();
}

function formatCooldown(ms) {
  if (ms <= 0) return "";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
