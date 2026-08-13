import { describe, it, expect, beforeEach } from 'vitest';
import { 
  initAccountPool,
  getNextAccount,
  recordAccountSuccess,
  recordAccountFailure,
  markAccountRateLimited,
  isAccountAvailable,
  getAvailableAccounts,
  getPoolStats,
  clearAllPools 
} from '../../open-sse/services/accountPoolManager.js';

describe('Account Pool Manager', () => {
  beforeEach(() => {
    clearAllPools();
  });

  const mockAccounts = [
    { id: 'account-1', email: 'user1@example.com', priority: 0 },
    { id: 'account-2', email: 'user2@example.com', priority: 1 },
    { id: 'account-3', email: 'user3@example.com', priority: 0 }
  ];

  describe('initAccountPool', () => {
    it('should initialize pool with accounts', () => {
      const pool = initAccountPool('test-provider', mockAccounts);
      expect(pool.providerId).toBe('test-provider');
      expect(pool.accounts.size).toBe(3);
    });

    it('should not duplicate accounts', () => {
      initAccountPool('test-provider', mockAccounts);
      initAccountPool('test-provider', mockAccounts);
      const stats = getPoolStats('test-provider');
      expect(stats.totalAccounts).toBe(3);
    });
  });

  describe('getNextAccount', () => {
    it('should return first available account', () => {
      initAccountPool('test-provider', mockAccounts);
      const account = getNextAccount('test-provider');
      expect(account).toBeDefined();
      expect(account.id).toBe('account-1');
    });

    it('should skip excluded accounts', () => {
      initAccountPool('test-provider', mockAccounts);
      const account = getNextAccount('test-provider', ['account-1']);
      expect(account.id).toBe('account-2');
    });

    it('should return null when no accounts available', () => {
      initAccountPool('test-provider', mockAccounts);
      const account = getNextAccount('test-provider', ['account-1', 'account-2', 'account-3']);
      expect(account).toBeNull();
    });

    it('should prefer higher priority accounts', () => {
      initAccountPool('test-provider', mockAccounts);
      const account = getNextAccount('test-provider');
      // account-2 has priority 1, should be preferred
      expect(account.id).toBe('account-2');
    });
  });

  describe('markAccountRateLimited', () => {
    it('should mark account as rate limited', () => {
      initAccountPool('test-provider', mockAccounts);
      markAccountRateLimited('test-provider', 'account-1');
      
      expect(isAccountAvailable('test-provider', 'account-1')).toBe(false);
    });

    it('should skip rate-limited account in getNextAccount', () => {
      initAccountPool('test-provider', mockAccounts);
      markAccountRateLimited('test-provider', 'account-1');
      
      const account = getNextAccount('test-provider');
      expect(account.id).not.toBe('account-1');
    });
  });

  describe('recordAccountSuccess', () => {
    it('should record success', () => {
      initAccountPool('test-provider', mockAccounts);
      recordAccountSuccess('test-provider', 'account-1', 100);
      
      const stats = getPoolStats('test-provider');
      const acc = stats.accounts.find(a => a.id === 'account-1');
      expect(acc.successCount).toBe(1);
    });
  });

  describe('recordAccountFailure', () => {
    it('should record failure', () => {
      initAccountPool('test-provider', mockAccounts);
      recordAccountFailure('test-provider', 'account-1', 'error');
      
      const stats = getPoolStats('test-provider');
      const acc = stats.accounts.find(a => a.id === 'account-1');
      expect(acc.failureCount).toBe(1);
    });

    it('should mark as rate limited on 429', () => {
      initAccountPool('test-provider', mockAccounts);
      recordAccountFailure('test-provider', 'account-1', 'rate limit', true);
      
      expect(isAccountAvailable('test-provider', 'account-1')).toBe(false);
    });
  });

  describe('getPoolStats', () => {
    it('should return pool statistics', () => {
      initAccountPool('test-provider', mockAccounts);
      markAccountRateLimited('test-provider', 'account-1');
      
      const stats = getPoolStats('test-provider');
      expect(stats.totalAccounts).toBe(3);
      expect(stats.availableAccounts).toBe(2);
      expect(stats.unavailableAccounts).toBe(1);
    });
  });
});
