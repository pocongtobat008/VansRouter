"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Badge, CardSkeleton } from "@/shared/components";

const STATUS_COLORS = {
  healthy: { bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" },
  recovering: { bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400", dot: "bg-amber-500" },
  unhealthy: { bg: "bg-red-500/10", text: "text-red-600 dark:text-red-400", dot: "bg-red-500" },
  unknown: { bg: "bg-gray-500/10", text: "text-gray-500", dot: "bg-gray-400" },
  active: { bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" },
  unavailable: { bg: "bg-red-500/10", text: "text-red-600 dark:text-red-400", dot: "bg-red-500" },
};

const CIRCUIT_LABELS = {
  closed: "Closed",
  open: "OPEN",
  half_open: "Half-Open",
};

function StatusDot({ status }) {
  const colors = STATUS_COLORS[status] || STATUS_COLORS.unknown;
  return (
    <span className={`inline-block h-2.5 w-2.5 rounded-full ${colors.dot} ${status === "unhealthy" || status === "unavailable" ? "animate-pulse" : ""}`} />
  );
}

function LatencyBadge({ p50, p95 }) {
  if (!p50 && !p95) return <span className="text-xs text-text-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className="font-mono text-text-main">{p50 ? `${p50}ms` : "—"}</span>
      <span className="text-text-muted">/</span>
      <span className="font-mono text-text-muted">{p95 ? `${p95}ms` : "—"}</span>
    </span>
  );
}

function FailureRate({ rate }) {
  if (rate === undefined || rate === null) return <span className="text-xs text-text-muted">—</span>;
  const pct = (rate * 100).toFixed(1);
  const color = rate > 0.5 ? "text-red-500" : rate > 0.2 ? "text-amber-500" : "text-emerald-500";
  return <span className={`text-xs font-mono ${color}`}>{pct}%</span>;
}

function ModelCard({ model, health, onReset }) {
  const status = health.status || "unknown";
  const colors = STATUS_COLORS[status] || STATUS_COLORS.unknown;

  return (
    <Card padding="sm" className="group">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <StatusDot status={status} />
            <span className="text-sm font-medium text-text-main truncate" title={model}>
              {model}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold ${colors.bg} ${colors.text}`}>
              {status}
            </span>
            {health.isRateLimited && (
              <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold bg-red-500/10 text-red-500 animate-pulse">
                ⚠ RATE LIMITED
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="flex flex-col">
            <span className="text-text-muted">Circuit</span>
            <span className={`font-medium ${health.circuitState === "open" ? "text-red-500" : health.circuitState === "half_open" ? "text-amber-500" : "text-text-main"}`}>
              {CIRCUIT_LABELS[health.circuitState] || health.circuitState}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-text-muted">Latency P50/P95</span>
            <LatencyBadge p50={health.latencyP50} p95={health.latencyP95} />
          </div>
          <div className="flex flex-col">
            <span className="text-text-muted">Failure Rate</span>
            <FailureRate rate={health.failureRate} />
          </div>
          <div className="flex flex-col">
            <span className="text-text-muted">Requests</span>
            <span className="font-mono text-text-main">{health.totalRequests || 0}</span>
          </div>
        </div>

        {health.lastError && (
          <div className="text-[11px] text-red-500 truncate" title={health.lastError}>
            Last error: {health.lastError}
          </div>
        )}

        <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onReset(model)}
            className="text-[10px] text-text-muted hover:text-primary transition-colors"
            title="Reset health state for this model"
          >
            Reset
          </button>
        </div>
      </div>
    </Card>
  );
}

function AccountCard({ account, onResetAccount }) {
  const status = account.isGlobalLocked ? "unavailable" : account.isActive ? "active" : "disabled";
  const colors = STATUS_COLORS[status] || STATUS_COLORS.unknown;
  const [resetting, setResetting] = useState(false);

  const handleReset = async () => {
    if (resetting) return;
    setResetting(true);
    try {
      await onResetAccount(account.id);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-black/[0.02] dark:hover:bg-white/[0.02] group">
      <StatusDot status={status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-main truncate" title={account.name}>
            {account.name}
          </span>
          {account.isGlobalLocked && (
            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold bg-red-500/10 text-red-500">
              <span className="material-symbols-outlined text-[10px]">block</span>
              GLOBAL LOCK
            </span>
          )}
          {account.modelLockCount > 0 && !account.isGlobalLocked && (
            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold bg-amber-500/10 text-amber-500">
              <span className="material-symbols-outlined text-[10px]">lock</span>
              MODEL LOCK ({account.modelLockCount})
            </span>
          )}
        </div>
        {account.lastError && (
          <div className="text-[11px] text-red-500 truncate mt-0.5" title={account.lastError}>
            {account.lastError}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {account.cooldownMs > 0 && (
          <span className="text-[10px] font-mono text-amber-500">
            ⏱ {account.cooldownHuman}
          </span>
        )}
        <span className={`text-[10px] font-semibold ${colors.text}`}>
          #{account.priority}
        </span>
        {(account.isGlobalLocked || account.modelLockCount > 0) && (
          <button
            onClick={handleReset}
            disabled={resetting}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-text-muted hover:text-primary disabled:opacity-50"
            title="Reset health state for this account"
          >
            {resetting ? "..." : "Reset"}
          </button>
        )}
      </div>
    </div>
  );
}

function LatencyGraph({ latencyData }) {
  if (!latencyData || latencyData.length === 0) {
    return (
      <Card padding="sm">
        <p className="text-sm text-text-muted text-center py-4">
          No latency data yet. Latency will be tracked after requests are made.
        </p>
      </Card>
    );
  }

  // Get max latency for scaling
  const maxLatency = Math.max(...latencyData.map(d => d.latencyMs), 100);
  const graphHeight = 120;

  return (
    <div className="relative">
      <svg width="100%" height={graphHeight} className="overflow-visible">
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
          <g key={pct}>
            <line
              x1="0"
              y1={graphHeight * (1 - pct)}
              x2="100%"
              y2={graphHeight * (1 - pct)}
              stroke="currentColor"
              strokeOpacity="0.1"
            />
            <text
              x="0"
              y={graphHeight * (1 - pct) - 4}
              fill="currentColor"
              className="text-[9px] fill-current text-text-muted"
            >
              {Math.round(maxLatency * pct)}ms
            </text>
          </g>
        ))}
        
        {/* Latency line */}
        <polyline
          fill="none"
          stroke="rgb(59, 130, 246)"
          strokeWidth="2"
          points={latencyData.map((d, i) => {
            const x = (i / Math.max(latencyData.length - 1, 1)) * 100;
            const y = graphHeight * (1 - d.latencyMs / maxLatency);
            return `${x}%,${y}`;
          }).join(" ")}
        />
        
        {/* Data points */}
        {latencyData.slice(-10).map((d, i) => {
          const idx = latencyData.length - 10 + i;
          if (idx < 0) return null;
          const x = (idx / Math.max(latencyData.length - 1, 1)) * 100;
          const y = graphHeight * (1 - d.latencyMs / maxLatency);
          return (
            <circle
              key={idx}
              cx={`${x}%`}
              cy={y}
              r="3"
              fill={d.success ? "rgb(59, 130, 246)" : "rgb(239, 68, 68)"}
              stroke="white"
              strokeWidth="1"
            />
          );
        })}
      </svg>
      
      {/* Legend */}
      <div className="flex items-center gap-4 mt-2 text-[10px] text-text-muted">
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-blue-500" />
          Success
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          Failure
        </div>
        <span>Avg: {Math.round(latencyData.reduce((a, b) => a + b.latencyMs, 0) / latencyData.length)}ms</span>
      </div>
    </div>
  );
}

function ProviderSection({ providerId, provider, expanded, onToggle, onResetAccount }) {
  return (
    <Card padding="sm">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-text-muted">dns</span>
          <span className="font-medium text-sm text-text-main">{provider.name || providerId}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-emerald-500">{provider.activeAccounts} active</span>
          {provider.lockedAccounts > 0 && (
            <span className="text-[10px] text-red-500">{provider.lockedAccounts} locked</span>
          )}
          <span className="material-symbols-outlined text-text-muted text-[18px]">
            {expanded ? "expand_less" : "expand_more"}
          </span>
        </div>
      </button>
      {expanded && (
        <div className="mt-3 border-t border-border/50 pt-3">
          <div className="grid grid-cols-1 gap-1">
            {provider.accounts.map(account => (
              <AccountCard key={account.id} account={account} onResetAccount={onResetAccount} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function ProviderBreakerCard({ provider }) {
  const breakerState = (provider.breakerState || "CLOSED").toLowerCase();
  const stateColor =
    breakerState === "open"
      ? "text-red-500"
      : breakerState === "half_open"
        ? "text-amber-500"
        : breakerState === "degraded"
          ? "text-amber-500"
          : "text-emerald-500";
  const usable = provider.activeAccounts > 0 && breakerState !== "open";

  return (
    <Card padding="sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-text-muted">dns</span>
          <span className="font-medium text-sm text-text-main truncate" title={provider.name}>
            {provider.name}
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${stateColor} ${
              breakerState === "open" || breakerState === "half_open" ? "bg-red-500/10" : "bg-emerald-500/10"
            }`}
          >
            {breakerState === "open" ? "● OPEN" : breakerState === "half_open" ? "◐ HALF-OPEN" : breakerState === "degraded" ? "◑ DEGRADED" : "● CLOSED"}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0 text-xs">
          <span className="text-emerald-500">{provider.activeAccounts} aktif</span>
          {provider.lockedAccounts > 0 && (
            <span className="text-red-500">{provider.lockedAccounts} locked</span>
          )}
          {provider.disabledAccounts > 0 && (
            <span className="text-text-muted">{provider.disabledAccounts} off</span>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-text-muted">
        <span>Total {provider.totalAccounts} akun</span>
        {provider.earliestRetryAfter ? (
          <span className="font-mono text-amber-500" title={provider.earliestRetryAfter}>
            ⏱ pulih dalam {provider.retryAfterHuman}
          </span>
        ) : usable ? (
          <span className="text-emerald-500">Siap dipakai</span>
        ) : (
          <span className="text-red-500">Tidak ada akun tersedia</span>
        )}
      </div>
      {provider.error && (
        <div className="mt-1 text-[11px] text-red-500 truncate" title={provider.error}>
          {provider.error}
        </div>
      )}
    </Card>
  );
}

function AlertBanner({ unhealthyCount, rateLimitedModels, lockedAccounts }) {
  if (unhealthyCount === 0 && rateLimitedModels.length === 0 && lockedAccounts === 0) return null;

  return (
    <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined text-red-500 text-[18px] mt-0.5">warning</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-red-600 dark:text-red-400">
            {unhealthyCount > 0 && `${unhealthyCount} model${unhealthyCount > 1 ? "s" : ""} unhealthy`}
            {unhealthyCount > 0 && rateLimitedModels.length > 0 && " · "}
            {rateLimitedModels.length > 0 && `${rateLimitedModels.length} rate-limited`}
            {lockedAccounts > 0 && ` · ${lockedAccounts} account${lockedAccounts > 1 ? "s" : ""} locked`}
          </p>
          {rateLimitedModels.length > 0 && (
            <p className="text-xs text-red-500/80 mt-1">
              Rate-limited: {rateLimitedModels.join(", ")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function HealthPage() {
  const [healthData, setHealthData] = useState(null);
  const [accountData, setAccountData] = useState(null);
  const [latencyData, setLatencyData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expandedProviders, setExpandedProviders] = useState(new Set());
  const [activeTab, setActiveTab] = useState("models");
  const [providerHealth, setProviderHealth] = useState(null);

  const fetchHealth = useCallback(async () => {
    try {
      const [modelsRes, accountsRes, latencyRes, providersRes] = await Promise.all([
        fetch("/api/health/models"),
        fetch("/api/health/all-accounts"),
        fetch("/api/health/latency"),
        fetch("/api/health/providers")
      ]);
      
      const modelsData = await modelsRes.json();
      const accountsData = await accountsRes.json();
      const latencyResult = await latencyRes.json();
      const providersData = await providersRes.json();
      
      if (modelsData.ok) {
        setHealthData(modelsData.models || {});
        setSummary(modelsData.summary || {});
      }
      
      if (accountsData.ok) {
        setAccountData(accountsData);
      }
      
      if (latencyResult.ok) {
        setLatencyData(latencyResult.providers || []);
      }
      
      if (providersData.ok) {
        setProviderHealth(providersData);
      }
      
      setLastRefresh(new Date());
    } catch (err) {
      console.error("Failed to fetch health data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    if (!autoRefresh) return;
    const interval = setInterval(fetchHealth, 5000);
    return () => clearInterval(interval);
  }, [fetchHealth, autoRefresh]);

  const handleResetModel = async (model) => {
    try {
      await fetch(`/api/health/reset?model=${encodeURIComponent(model)}`);
      fetchHealth();
    } catch (err) {
      console.error("Failed to reset health:", err);
    }
  };

  const handleResetAccount = async (connectionId) => {
    try {
      await fetch("/api/health/reset-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId })
      });
      fetchHealth();
    } catch (err) {
      console.error("Failed to reset account:", err);
    }
  };

  const handleResetAll = async () => {
    if (!confirm("Reset ALL health state? Models will be retried immediately.")) return;
    try {
      await fetch("/api/health/reset");
      fetchHealth();
    } catch (err) {
      console.error("Failed to reset all health:", err);
    }
  };

  const toggleProvider = (providerId) => {
    setExpandedProviders(prev => {
      const next = new Set(prev);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  const models = Object.entries(healthData || {});
  const unhealthyModels = models.filter(([_, h]) => h.status === "unhealthy");
  const rateLimitedModels = models.filter(([_, h]) => h.isRateLimited).map(([m]) => m);

  if (loading) {
    return (
      <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold">Health Dashboard</h1>
          <p className="text-sm text-text-muted mt-1">
            Real-time health status of models and accounts
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              autoRefresh
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-black/5 dark:bg-white/5 text-text-muted"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${autoRefresh ? "bg-emerald-500 animate-pulse" : "bg-gray-400"}`} />
            {autoRefresh ? "Live" : "Paused"}
          </button>
          <Button variant="ghost" size="sm" onClick={handleResetAll} className="text-xs">
            Reset All
          </Button>
          {lastRefresh && (
            <span className="text-[10px] text-text-muted">
              {lastRefresh.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      <AlertBanner
        unhealthyCount={unhealthyModels.length}
        rateLimitedModels={rateLimitedModels}
        lockedAccounts={accountData?.summary?.lockedAccounts || 0}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card padding="sm">
          <div className="text-center">
            <p className="text-2xl font-bold text-text-main">{summary?.total || 0}</p>
            <p className="text-xs text-text-muted">Total Models</p>
          </div>
        </Card>
        <Card padding="sm">
          <div className="text-center">
            <p className="text-2xl font-bold text-emerald-500">{summary?.healthy || 0}</p>
            <p className="text-xs text-text-muted">Healthy</p>
          </div>
        </Card>
        <Card padding="sm">
          <div className="text-center">
            <p className="text-2xl font-bold text-red-500">{summary?.unhealthy || 0}</p>
            <p className="text-xs text-text-muted">Unhealthy</p>
          </div>
        </Card>
        <Card padding="sm">
          <div className="text-center">
            <p className="text-2xl font-bold text-amber-500">{accountData?.summary?.lockedAccounts || 0}</p>
            <p className="text-xs text-text-muted">Accounts Locked</p>
          </div>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-black/5 dark:bg-white/5 rounded-lg w-fit">
        <button
          onClick={() => setActiveTab("models")}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            activeTab === "models"
              ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
              : "text-text-muted hover:text-text-main"
          }`}
        >
          Models ({models.length})
        </button>
        <button
          onClick={() => setActiveTab("accounts")}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            activeTab === "accounts"
              ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
              : "text-text-muted hover:text-text-main"
          }`}
        >
          Accounts ({accountData?.summary?.totalAccounts || 0})
        </button>
        <button
          onClick={() => setActiveTab("providers")}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            activeTab === "providers"
              ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
              : "text-text-muted hover:text-text-main"
          }`}
        >
          Providers ({Object.keys(providerHealth?.providers || {}).length})
        </button>
        <button
          onClick={() => setActiveTab("latency")}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            activeTab === "latency"
              ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
              : "text-text-muted hover:text-text-main"
          }`}
        >
          Latency
        </button>
      </div>

      {/* Content */}
      {activeTab === "models" && (
        <div className="grid grid-cols-1 gap-3">
          {models.length === 0 ? (
            <Card padding="sm">
              <p className="text-sm text-text-muted text-center py-4">
                No model health data yet.
              </p>
            </Card>
          ) : (
            models.map(([model, health]) => (
              <ModelCard key={model} model={model} health={health} onReset={handleResetModel} />
            ))
          )}
        </div>
      )}

      {activeTab === "accounts" && (
        <div className="grid grid-cols-1 gap-3">
          {!accountData?.providers || Object.keys(accountData.providers).length === 0 ? (
            <Card padding="sm">
              <p className="text-sm text-text-muted text-center py-4">
                No provider accounts configured.
              </p>
            </Card>
          ) : (
            Object.entries(accountData.providers).map(([providerId, provider]) => (
              <ProviderSection
                key={providerId}
                providerId={providerId}
                provider={provider}
                expanded={expandedProviders.has(providerId)}
                onToggle={() => toggleProvider(providerId)}
                onResetAccount={handleResetAccount}
              />
            ))
          )}
        </div>
      )}

      {activeTab === "providers" && (
        <div className="grid grid-cols-1 gap-3">
          {!providerHealth?.providers || Object.keys(providerHealth.providers).length === 0 ? (
            <Card padding="sm">
              <p className="text-sm text-text-muted text-center py-4">
                No provider data yet.
              </p>
            </Card>
          ) : (
            Object.entries(providerHealth.providers).map(([providerId, provider]) => (
              <ProviderBreakerCard key={providerId} provider={provider} />
            ))
          )}
        </div>
      )}

      {activeTab === "latency" && (
        <div className="grid grid-cols-1 gap-3">
          {!latencyData || latencyData.length === 0 ? (
            <Card padding="sm">
              <p className="text-sm text-text-muted text-center py-4">
                No latency data yet. Latency will be tracked after requests are made.
              </p>
            </Card>
          ) : (
            latencyData.map(provider => (
              <Card key={provider.providerId} padding="sm">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-text-main">{provider.providerId}</h3>
                  <div className="flex items-center gap-3 text-[10px] text-text-muted">
                    <span>Avg: <span className="font-mono text-text-main">{provider.stats.avg}ms</span></span>
                    <span>P50: <span className="font-mono text-text-main">{provider.stats.p50}ms</span></span>
                    <span>P95: <span className="font-mono text-text-main">{provider.stats.p95}ms</span></span>
                    <span className="text-emerald-500">{provider.successCount} ok</span>
                    {provider.failureCount > 0 && (
                      <span className="text-red-500">{provider.failureCount} fail</span>
                    )}
                  </div>
                </div>
                <LatencyGraph latencyData={provider.history} />
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
