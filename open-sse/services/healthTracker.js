/**
 * Health Tracker Service
 * 
 * Tracks real-time health status of models and accounts:
 * - Success/failure rate
 * - Latency tracking
 * - Circuit breaker pattern
 * - Rate limit detection
 */

// In-memory health state
const healthState = new Map();

// Circuit breaker states
const CIRCUIT_STATES = {
  CLOSED: 'closed',      // Normal operation
  OPEN: 'open',          // Failing, skip this model/account
  HALF_OPEN: 'half_open' // Testing if recovery
};

// Default config
const DEFAULT_CONFIG = {
  failureThreshold: 3,        // Failures before opening circuit
  recoveryTimeoutMs: 60000,  // Time before trying again (1 min)
  successThreshold: 2,        // Successes to close circuit
  latencyWindowMs: 300000,    // 5 min window for latency tracking
  maxLatencySamples: 100,     // Max samples to keep
};

/**
 * Get or create health state for a key (model/account)
 */
function getHealthState(key) {
  if (!healthState.has(key)) {
    healthState.set(key, {
      key,
      circuitState: CIRCUIT_STATES.CLOSED,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
      lastError: null,
      latencySamples: [],
      totalRequests: 0,
      totalFailures: 0,
      rateLimitedUntil: null,
      createdAt: Date.now()
    });
  }
  return healthState.get(key);
}

/**
 * Record a successful request
 */
export function recordSuccess(key, latencyMs = null) {
  const state = getHealthState(key);
  
  state.consecutiveSuccesses++;
  state.consecutiveFailures = 0;
  state.lastSuccessTime = Date.now();
  state.totalRequests++;
  
  // Track latency
  if (latencyMs !== null && latencyMs !== undefined) {
    state.latencySamples.push({
      value: latencyMs,
      timestamp: Date.now()
    });
    // Keep only recent samples
    const cutoff = Date.now() - DEFAULT_CONFIG.latencyWindowMs;
    state.latencySamples = state.latencySamples
      .filter(s => s.timestamp > cutoff)
      .slice(-DEFAULT_CONFIG.maxLatencySamples);
  }
  
  // Close circuit if we have enough successes
  if (state.circuitState === CIRCUIT_STATES.HALF_OPEN && 
      state.consecutiveSuccesses >= DEFAULT_CONFIG.successThreshold) {
    state.circuitState = CIRCUIT_STATES.CLOSED;
    console.log(`[HealthTracker] Circuit CLOSED for ${key}`);
  }
  
  return state;
}

/**
 * Record a failed request
 */
export function recordFailure(key, error = null, isRateLimit = false) {
  const state = getHealthState(key);
  
  state.consecutiveFailures++;
  state.consecutiveSuccesses = 0;
  state.lastFailureTime = Date.now();
  state.lastError = error;
  state.totalRequests++;
  state.totalFailures++;
  
  // Track rate limiting
  if (isRateLimit) {
    // Set rate limited for at least 5 minutes (breaker rest period)
    state.rateLimitedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  }
  
  // Open circuit if we hit failure threshold
  if (state.circuitState === CIRCUIT_STATES.CLOSED && 
      state.consecutiveFailures >= DEFAULT_CONFIG.failureThreshold) {
    state.circuitState = CIRCUIT_STATES.OPEN;
    state.lastFailureTime = Date.now();
    console.log(`[HealthTracker] Circuit OPENED for ${key} after ${state.consecutiveFailures} failures`);
  }
  
  // Move to half-open after recovery timeout
  if (state.circuitState === CIRCUIT_STATES.OPEN && 
      state.lastFailureTime && 
      (Date.now() - state.lastFailureTime) > DEFAULT_CONFIG.recoveryTimeoutMs) {
    state.circuitState = CIRCUIT_STATES.HALF_OPEN;
    state.consecutiveSuccesses = 0;
    console.log(`[HealthTracker] Circuit HALF-OPEN for ${key} - testing recovery`);
  }
  
  return state;
}

/**
 * Check if a model/account is available
 */
export function isAvailable(key) {
  const state = healthState.get(key);
  if (!state) return true; // Unknown = available
  
  // Check circuit breaker
  if (state.circuitState === CIRCUIT_STATES.OPEN) {
    // Check if recovery timeout has passed
    if (state.lastFailureTime && 
        (Date.now() - state.lastFailureTime) > DEFAULT_CONFIG.recoveryTimeoutMs) {
      state.circuitState = CIRCUIT_STATES.HALF_OPEN;
      return true; // Allow one test request
    }
    return false;
  }
  
  // Check rate limiting
  if (state.rateLimitedUntil) {
    if (new Date(state.rateLimitedUntil).getTime() > Date.now()) {
      return false;
    }
    state.rateLimitedUntil = null;
  }
  
  return true;
}

/**
 * Get health status for a key
 */
export function getHealthStatus(key) {
  const state = healthState.get(key);
  if (!state) {
    return {
      key,
      status: 'unknown',
      circuitState: CIRCUIT_STATES.CLOSED,
      latencyP50: null,
      latencyP95: null,
      failureRate: 0
    };
  }
  
  // Calculate latency percentiles
  const sortedLatencies = state.latencySamples
    .map(s => s.value)
    .sort((a, b) => a - b);
  
  const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] || null;
  const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] || null;
  
  return {
    key,
    status: state.circuitState === CIRCUIT_STATES.OPEN ? 'unhealthy' : 
            state.circuitState === CIRCUIT_STATES.HALF_OPEN ? 'recovering' : 'healthy',
    circuitState: state.circuitState,
    consecutiveFailures: state.consecutiveFailures,
    consecutiveSuccesses: state.consecutiveSuccesses,
    lastFailureTime: state.lastFailureTime,
    lastSuccessTime: state.lastSuccessTime,
    lastError: state.lastError,
    latencyP50: p50,
    latencyP95: p95,
    totalRequests: state.totalRequests,
    totalFailures: state.totalFailures,
    failureRate: state.totalRequests > 0 ? state.totalFailures / state.totalRequests : 0,
    isRateLimited: state.rateLimitedUntil ? new Date(state.rateLimitedUntil).getTime() > Date.now() : false,
    rateLimitedUntil: state.rateLimitedUntil
  };
}

/**
 * Get all health statuses
 */
export function getAllHealthStatuses() {
  const statuses = {};
  for (const [key, _] of healthState) {
    statuses[key] = getHealthStatus(key);
  }
  return statuses;
}

/**
 * Sort keys by health (healthy first, then by latency)
 * Models with circuit OPEN or rate-limited are filtered OUT entirely
 * (they go to the very end of the list but are still present for
 * fallback — they just won't be tried first).
 */
export function sortByHealth(keys) {
  return keys
    .map(key => ({
      key,
      health: getHealthStatus(key),
      available: isAvailable(key)
    }))
    .sort((a, b) => {
      // Available models first
      if (a.available !== b.available) return a.available ? -1 : 1;
      
      // Healthy first
      const statusOrder = { healthy: 0, recovering: 1, unknown: 2, unhealthy: 3 };
      const statusDiff = (statusOrder[a.health.status] || 2) - (statusOrder[b.health.status] || 2);
      if (statusDiff !== 0) return statusDiff;
      
      // Then by latency (lower is better)
      const latencyA = a.health.latencyP50 || Infinity;
      const latencyB = b.health.latencyP50 || Infinity;
      return latencyA - latencyB;
    })
    .map(item => item.key);
}

/**
 * Reset health state for a key
 */
export function resetHealth(key) {
  healthState.delete(key);
}

/**
 * Clear all health state
 */
export function clearAllHealth() {
  healthState.clear();
}

/**
 * Get health stats summary
 */
export function getHealthSummary() {
  let total = 0;
  let healthy = 0;
  let unhealthy = 0;
  let recovering = 0;
  
  for (const [key, _] of healthState) {
    total++;
    const status = getHealthStatus(key);
    if (status.status === 'healthy') healthy++;
    else if (status.status === 'unhealthy') unhealthy++;
    else if (status.status === 'recovering') recovering++;
  }
  
  return {
    total,
    healthy,
    unhealthy,
    recovering,
    unknown: total - healthy - unhealthy - recovering
  };
}

export default {
  recordSuccess,
  recordFailure,
  isAvailable,
  getHealthStatus,
  getAllHealthStatuses,
  sortByHealth,
  resetHealth,
  clearAllHealth,
  getHealthSummary,
  CIRCUIT_STATES
};
