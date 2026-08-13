/**
 * Account Pool Manager
 * 
 * Manages a pool of accounts for each provider with:
 * - Immediate failover when account is rate-limited
 * - Health-based account selection
 * - Priority rotation
 * - Account health tracking
 */

import healthTracker from './healthTracker.js';

// Account pools per provider
const accountPools = new Map();

// Default config
const DEFAULT_CONFIG = {
  maxRetriesPerAccount: 3,        // Max consecutive failures before marking unhealthy
  cooldownMs: 5 * 60 * 1000,      // Default cooldown (~5 min rest) for rate-limited accounts
  healthCheckIntervalMs: 300000,  // 5 min health check interval
  priorityBoostMs: 300000,        // Boost priority after 5 min of success
};

/**
 * Initialize account pool for a provider
 */
export function initAccountPool(providerId, accounts) {
  if (!accountPools.has(providerId)) {
    accountPools.set(providerId, {
      providerId,
      accounts: new Map(),
      currentIndex: 0,
      createdAt: Date.now()
    });
  }
  
  const pool = accountPools.get(providerId);
  
  // Add or update accounts
  for (const account of accounts) {
    const accountId = account.id || account.email || account.connectionId;
    if (!pool.accounts.has(accountId)) {
      pool.accounts.set(accountId, {
        id: accountId,
        account,
        priority: account.priority || 0,
        healthKey: `${providerId}:${accountId}`,
        lastUsed: null,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        rateLimitedUntil: null,
        createdAt: Date.now()
      });
    }
  }
  
  return pool;
}

/**
 * Get the next available account from the pool
 * Uses health-based selection with immediate failover
 */
export function getNextAccount(providerId, excludeAccountIds = []) {
  const pool = accountPools.get(providerId);
  if (!pool) return null;
  
  // Get all accounts sorted by health and priority
  const sortedAccounts = Array.from(pool.accounts.values())
    .filter(acc => !excludeAccountIds.includes(acc.id))
    .map(acc => {
      const health = healthTracker.getHealthStatus(acc.healthKey);
      const isAvailable = healthTracker.isAvailable(acc.healthKey);
      const isRateLimited = acc.rateLimitedUntil && 
        new Date(acc.rateLimitedUntil).getTime() > Date.now();
      
      return {
        ...acc,
        health,
        isAvailable: isAvailable && !isRateLimited,
        score: calculateAccountScore(acc, health)
      };
    })
    .filter(acc => acc.isAvailable)
    .sort((a, b) => b.score - a.score);
  
  if (sortedAccounts.length === 0) {
    console.log(`[AccountPool] No available accounts for ${providerId}`);
    return null;
  }
  
  // Return the best available account
  const best = sortedAccounts[0];
  best.lastUsed = Date.now();
  best.successCount++;
  best.consecutiveFailures = 0;
  
  return best.account;
}

/**
 * Calculate account score for selection (higher is better)
 */
function calculateAccountScore(account, health) {
  let score = 0;
  
  // Health status (0-100)
  if (health.status === 'healthy') score += 100;
  else if (health.status === 'recovering') score += 50;
  else if (health.status === 'unknown') score += 30;
  else score += 0; // unhealthy
  
  // Latency (lower is better, max 50 points)
  if (health.latencyP50) {
    score += Math.max(0, 50 - (health.latencyP50 / 100));
  }
  
  // Success rate (0-50 points)
  if (health.totalRequests > 0) {
    const successRate = 1 - health.failureRate;
    score += successRate * 50;
  }
  
  // Priority boost (0-30 points)
  score += (account.priority || 0) * 10;
  
  // Recency penalty (deduct if used recently)
  if (account.lastUsed) {
    const timeSinceUse = Date.now() - account.lastUsed;
    if (timeSinceUse < 10000) score -= 20; // Used in last 10 seconds
    else if (timeSinceUse < 30000) score -= 10; // Used in last 30 seconds
  }
  
  return score;
}

/**
 * Record account success
 */
export function recordAccountSuccess(providerId, accountId, latencyMs = null) {
  const pool = accountPools.get(providerId);
  if (!pool) return;
  
  const accountData = pool.accounts.get(accountId);
  if (!accountData) return;
  
  accountData.successCount++;
  accountData.consecutiveFailures = 0;
  accountData.lastUsed = Date.now();
  
  // Record in health tracker
  healthTracker.recordSuccess(accountData.healthKey, latencyMs);
}

/**
 * Record account failure
 */
export function recordAccountFailure(providerId, accountId, error = null, isRateLimit = false) {
  const pool = accountPools.get(providerId);
  if (!pool) return;
  
  const accountData = pool.accounts.get(accountId);
  if (!accountData) return;
  
  accountData.failureCount++;
  accountData.consecutiveFailures++;
  
  // Set rate limited if applicable
  if (isRateLimit) {
    accountData.rateLimitedUntil = new Date(Date.now() + DEFAULT_CONFIG.cooldownMs).toISOString();
  }
  
  // Record in health tracker
  healthTracker.recordFailure(accountData.healthKey, error, isRateLimit);
  
  // Mark as unhealthy if too many consecutive failures
  if (accountData.consecutiveFailures >= DEFAULT_CONFIG.maxRetriesPerAccount) {
    console.log(`[AccountPool] Account ${accountId} marked unhealthy after ${accountData.consecutiveFailures} consecutive failures`);
  }
}

/**
 * Mark account as rate-limited
 */
export function markAccountRateLimited(providerId, accountId, cooldownMs = null) {
  const pool = accountPools.get(providerId);
  if (!pool) return;
  
  const accountData = pool.accounts.get(accountId);
  if (!accountData) return;
  
  const cooldown = cooldownMs || DEFAULT_CONFIG.cooldownMs;
  accountData.rateLimitedUntil = new Date(Date.now() + cooldown).toISOString();
  
  console.log(`[AccountPool] Account ${accountId} rate-limited for ${cooldown}ms`);
}

/**
 * Check if account is available
 */
export function isAccountAvailable(providerId, accountId) {
  const pool = accountPools.get(providerId);
  if (!pool) return false;
  
  const accountData = pool.accounts.get(accountId);
  if (!accountData) return false;
  
  // Check rate limiting
  if (accountData.rateLimitedUntil && 
      new Date(accountData.rateLimitedUntil).getTime() > Date.now()) {
    return false;
  }
  
  // Check health
  return healthTracker.isAvailable(accountData.healthKey);
}

/**
 * Get all available accounts for a provider
 */
export function getAvailableAccounts(providerId) {
  const pool = accountPools.get(providerId);
  if (!pool) return [];
  
  return Array.from(pool.accounts.values())
    .filter(acc => isAccountAvailable(providerId, acc.id))
    .sort((a, b) => b.priority - a.priority);
}

/**
 * Get account health status
 */
export function getAccountHealth(providerId, accountId) {
  const pool = accountPools.get(providerId);
  if (!pool) return null;
  
  const accountData = pool.accounts.get(accountId);
  if (!accountData) return null;
  
  return healthTracker.getHealthStatus(accountData.healthKey);
}

/**
 * Get pool statistics
 */
export function getPoolStats(providerId) {
  const pool = accountPools.get(providerId);
  if (!pool) return null;
  
  const accounts = Array.from(pool.accounts.values());
  const available = accounts.filter(acc => isAccountAvailable(providerId, acc.id));
  
  return {
    providerId,
    totalAccounts: accounts.length,
    availableAccounts: available.length,
    unavailableAccounts: accounts.length - available.length,
    accounts: accounts.map(acc => ({
      id: acc.id,
      priority: acc.priority,
      successCount: acc.successCount,
      failureCount: acc.failureCount,
      consecutiveFailures: acc.consecutiveFailures,
      isAvailable: isAccountAvailable(providerId, acc.id),
      isRateLimited: acc.rateLimitedUntil && new Date(acc.rateLimitedUntil).getTime() > Date.now(),
      health: healthTracker.getHealthStatus(acc.healthKey)
    }))
  };
}

/**
 * Remove account from pool
 */
export function removeAccount(providerId, accountId) {
  const pool = accountPools.get(providerId);
  if (!pool) return;
  
  pool.accounts.delete(accountId);
}

/**
 * Clear all pools
 */
export function clearAllPools() {
  accountPools.clear();
}

export default {
  initAccountPool,
  getNextAccount,
  recordAccountSuccess,
  recordAccountFailure,
  markAccountRateLimited,
  isAccountAvailable,
  getAvailableAccounts,
  getAccountHealth,
  getPoolStats,
  removeAccount,
  clearAllPools
};
