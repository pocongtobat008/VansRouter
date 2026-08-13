import { describe, it, expect, beforeEach } from 'vitest';
import { 
  recordSuccess, 
  recordFailure, 
  isAvailable, 
  getHealthStatus, 
  getAllHealthStatuses, 
  sortByHealth, 
  resetHealth, 
  clearAllHealth,
  CIRCUIT_STATES 
} from '../../open-sse/services/healthTracker.js';

describe('Health Tracker', () => {
  beforeEach(() => {
    clearAllHealth();
  });

  describe('recordSuccess', () => {
    it('should record successful request', () => {
      const key = 'test:model1';
      recordSuccess(key, 150);
      
      const status = getHealthStatus(key);
      expect(status.status).toBe('healthy');
      expect(status.consecutiveSuccesses).toBe(1);
      expect(status.totalRequests).toBe(1);
      expect(status.totalFailures).toBe(0);
      expect(status.latencyP50).toBe(150);
    });

    it('should reset consecutive failures on success', () => {
      const key = 'test:model1';
      recordFailure(key, 'error');
      recordFailure(key, 'error');
      recordSuccess(key);
      
      const status = getHealthStatus(key);
      expect(status.consecutiveFailures).toBe(0);
      expect(status.consecutiveSuccesses).toBe(1);
    });
  });

  describe('recordFailure', () => {
    it('should record failed request', () => {
      const key = 'test:model1';
      recordFailure(key, 'error message');
      
      const status = getHealthStatus(key);
      expect(status.consecutiveFailures).toBe(1);
      expect(status.totalRequests).toBe(1);
      expect(status.totalFailures).toBe(1);
      expect(status.lastError).toBe('error message');
    });

    it('should open circuit after failure threshold', () => {
      const key = 'test:model1';
      // Default threshold is 3
      recordFailure(key, 'error');
      recordFailure(key, 'error');
      recordFailure(key, 'error');
      
      const status = getHealthStatus(key);
      expect(status.circuitState).toBe(CIRCUIT_STATES.OPEN);
      expect(status.status).toBe('unhealthy');
    });

    it('should mark as rate limited', () => {
      const key = 'test:model1';
      recordFailure(key, 'rate limit', true);
      
      const status = getHealthStatus(key);
      expect(status.isRateLimited).toBe(true);
    });
  });

  describe('isAvailable', () => {
    it('should return true for unknown model', () => {
      expect(isAvailable('unknown:model')).toBe(true);
    });

    it('should return true for healthy model', () => {
      const key = 'test:model1';
      recordSuccess(key);
      expect(isAvailable(key)).toBe(true);
    });

    it('should return false for rate-limited model', () => {
      const key = 'test:model1';
      recordFailure(key, 'rate limit', true);
      expect(isAvailable(key)).toBe(false);
    });

    it('should return false for open circuit', () => {
      const key = 'test:model1';
      recordFailure(key, 'error');
      recordFailure(key, 'error');
      recordFailure(key, 'error');
      expect(isAvailable(key)).toBe(false);
    });
  });

  describe('sortByHealth', () => {
    it('should sort healthy models first', () => {
      const models = ['model-a', 'model-b', 'model-c'];
      
      // model-b is healthy
      recordSuccess('model-b', 100);
      
      // model-c is unhealthy
      recordFailure('model-c', 'error');
      recordFailure('model-c', 'error');
      recordFailure('model-c', 'error');
      
      // model-a is unknown
      
      const sorted = sortByHealth(models);
      expect(sorted[0]).toBe('model-b');
      expect(sorted[2]).toBe('model-c');
    });

    it('should sort by latency when health is equal', () => {
      const models = ['model-a', 'model-b'];
      
      recordSuccess('model-a', 200);
      recordSuccess('model-b', 100);
      
      const sorted = sortByHealth(models);
      expect(sorted[0]).toBe('model-b');
    });
  });

  describe('getAllHealthStatuses', () => {
    it('should return all tracked models', () => {
      recordSuccess('model-a');
      recordSuccess('model-b');
      recordFailure('model-c', 'error');
      
      const statuses = getAllHealthStatuses();
      expect(Object.keys(statuses)).toHaveLength(3);
      expect(statuses['model-a']).toBeDefined();
      expect(statuses['model-b']).toBeDefined();
      expect(statuses['model-c']).toBeDefined();
    });
  });
});
