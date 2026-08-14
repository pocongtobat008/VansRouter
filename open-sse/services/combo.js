/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter } from "./accountFallback.js";
import { recordSuccess, recordFailure, isAvailable, sortByHealth } from "./healthTracker.js";
import { unavailableResponse } from "../utils/error.js";
import { DEFAULT_COMBO_TARGET_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { extractTextContent } from "../translator/formats/gemini.js";

// Strip "combo/" prefix from model string (e.g. "combo/coding-stack" → "coding-stack")
export function stripComboPrefix(modelStr) {
  if (typeof modelStr !== "string") return modelStr;
  return modelStr.startsWith("combo/") ? modelStr.slice(6) : modelStr;
}

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            if (block.type === "tool_use") toolNames.push(block.name || "tool");
            if (block.type === "tool_result") toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          return { ...rest, content: newContent };
        }
      }
      return msg;
    });
}

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  const tiered = models.map((m, i) => ({ m, i, t: tierOf(m) }));
  // If no model matches any hard capability, return original reference (no reorder needed).
  if (tiered.every((x) => x.t === 2)) return models;
  return tiered
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

/**
 * Smart ordering: sort models by health status and latency
 * Uses Health Tracker to determine which models are healthy and fast
 */
export function orderByHealth(models) {
  if (!Array.isArray(models) || models.length <= 1) return models;
  return sortByHealth(models);
}

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "file" || t === "document" || t === "input_file") required.add("pdf");
    // gemini parts: inlineData/fileData carry a mime
    const mime = b.inlineData?.mimeType || b.fileData?.mimeType;
    if (typeof mime === "string" && mime.startsWith("image/")) required.add("vision");
    if (mime === "application/pdf") required.add("pdf");
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanContent(m.content);      // openai / claude
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // search: detect web_search tool in tools array
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool?.type === "web_search") { required.add("search"); break; }
    }
  }

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Combine multiple AbortSignals into one. The returned signal aborts as soon as
 * any source aborts. Sources that are not AbortSignal instances are ignored.
 */
function combineSignals(...signals) {
  const sources = signals.filter((s) => s && typeof s.addEventListener === "function");
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0];

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  let aborted = false;

  for (const sig of sources) {
    if (sig.aborted) {
      aborted = true;
      break;
    }
    sig.addEventListener("abort", onAbort, { once: true });
  }

  if (aborted) {
    controller.abort();
  }

  return controller.signal;
}

/**
 * Fire two combo targets in parallel and keep the first that succeeds (HTTP ok).
 * The loser is aborted via its own AbortController as soon as a winner exists,
 * bounding the extra cost to one duplicate request while removing the
 * wait-for-first-model penalty from the critical path.
 *
 * When both fail, resolves with { winner: null, errorText, status, ... } so the
 * caller can fall back to the remaining (unraced) models.
 */
async function raceTwoTargets({ body, models, handleSingleModel, externalSignal, timeoutMs, queueDepth }) {
  return new Promise((resolve) => {
    const controllers = [new AbortController(), new AbortController()];
    const signals = [
      combineSignals(externalSignal, controllers[0].signal),
      combineSignals(externalSignal, controllers[1].signal),
    ];
    let settled = 0;
    let finished = false;
    const failures = [null, null];

    const finish = (payload) => {
      if (finished) return;
      finished = true;
      resolve(payload);
    };

    const run = (i) => {
      const targetOptions = {};
      if (signals[i]) targetOptions.signal = signals[i];
      if (queueDepth != null) targetOptions.maxQueueSize = queueDepth;

      let timeoutId = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutId = setTimeout(() => controllers[i].abort(new Error("combo-race-timeout")), timeoutMs);
      }

      Promise.resolve(handleSingleModel(body, models[i], Object.keys(targetOptions).length > 0 ? targetOptions : undefined))
        .then(async (res) => {
          clearTimeout(timeoutId);
          if (res && res.ok) {
            controllers[1 - i].abort(new Error("combo-race-loser"));
            finish({ winner: i, response: res });
            return;
          }
          failures[i] = await extractRaceFailure(res);
          settled++;
          if (settled === 2) {
            const first = failures[0] || failures[1];
            finish({ winner: null, ...first });
          }
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          failures[i] = { errorText: err?.message || String(err), status: null, isRateLimit: false, allRateLimited: false };
          settled++;
          if (settled === 2) {
            const first = failures[0] || failures[1];
            finish({ winner: null, ...first });
          }
        });
    };

    run(0);
    run(1);
  });
}

/** Extract error summary from a non-ok combo response for fallback bookkeeping. */
async function extractRaceFailure(res) {
  let errorText = res?.statusText || "";
  let allRateLimited = false;
  try {
    const errorBody = await res.clone().json();
    errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
    allRateLimited = errorBody?.allRateLimited === true;
  } catch {
    // Non-JSON error body — keep statusText.
  }
  return {
    errorText: typeof errorText === "string" ? errorText : JSON.stringify(errorText),
    status: res?.status || null,
    isRateLimit: res?.status === 429,
    allRateLimited,
  };
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr, { signal }) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback" or "round-robin"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @param {AbortSignal} [options.signal] - Optional external signal (e.g. client disconnect) that aborts every target
 * @param {number} [options.timeoutMs=DEFAULT_COMBO_TARGET_TIMEOUT_MS] - Max time to wait for a target to return response headers
 * @param {number} [options.queueDepth] - Optional per-combo account-semaphore queue depth (0 = fail immediately on saturation)
 * @param {boolean} [options.race=false] - Fire the top 2 models in parallel and keep the first to succeed
 * @returns {Promise<Response>}
 */
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, autoSwitch = true, signal = null, timeoutMs = DEFAULT_COMBO_TARGET_TIMEOUT_MS, queueDepth = null, race = false }) {
  // Apply rotation strategy if enabled
  let rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);

  // Smart strategy: order by health status and latency
  if (comboStrategy === "smart") {
    rotatedModels = orderByHealth(rotatedModels);
    log.info("COMBO", `Smart ordering applied: ${rotatedModels[0]} (best health)`);
  }

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
  }
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;
  // Providers whose EVERY account is currently rate-limited. Once one model of a
  // provider reports allRateLimited, skip the remaining models of that provider
  // in this run instead of trying each one-by-one (they'd all fail the same way).
  const exhaustedProviders = new Set();

  // Race mode: fire the top 2 models in parallel, keep the first to succeed.
  // The loser is aborted (bounded extra cost = one duplicate request) and the
  // remaining models still run as an ordered fallback below. Both failures are
  // recorded for health tracking; provider-exhaustion is honored so a
  // fully-locked provider isn't retried.
  let raceIndex = 0;
  if (race && rotatedModels.length >= 2) {
    const raceStart = Date.now();
    const raceModels = rotatedModels.slice(0, 2);
    log.info("COMBO", `Racing ${raceModels[0]} vs ${raceModels[1]} (first ok wins)`);
    const raced = await raceTwoTargets({
      body,
      models: raceModels,
      handleSingleModel,
      externalSignal: signal,
      timeoutMs,
      queueDepth,
    });

    if (raced.winner != null) {
      const winnerModel = raceModels[raced.winner];
      const elapsedMs = Date.now() - raceStart;
      recordSuccess(winnerModel, elapsedMs, elapsedMs);
      log.info("COMBO", `Race winner: ${winnerModel} succeeded in ${elapsedMs}ms`);
      return raced.response;
    }

    // Both raced models failed — record both for health tracking.
    for (const modelStr of raceModels) {
      recordFailure(modelStr, raced.errorText || "race failed", raced.isRateLimit === true);
    }
    lastError = raced.errorText || "All raced models failed";
    if (raced.status) lastStatus = raced.status;
    if (raced.allRateLimited) {
      for (const modelStr of raceModels) {
        const p = modelStr.includes("/") ? modelStr.split("/")[0] : "";
        if (p) exhaustedProviders.add(p);
      }
    }
    log.warn("COMBO", `Race ${raceModels[0]} vs ${raceModels[1]} both failed (${lastError}) — falling back`);
    raceIndex = 2; // skip the raced models; continue with the rest
  }

  for (let i = raceIndex; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];

    // Honor external abort before trying the next target.
    if (signal?.aborted) {
      log.info("COMBO", "External signal aborted — stopping combo fallback");
      return new Response(
        JSON.stringify({ error: { message: "Client disconnected" } }),
        { status: 499, headers: { "Content-Type": "application/json" } }
      );
    }

    // Skip other models from a provider whose accounts are all rate-limited
    // (they would fail identically — save the upstream calls + latency).
    const modelProvider = modelStr.includes("/") ? modelStr.split("/")[0] : "";
    if (modelProvider && exhaustedProviders.has(modelProvider)) {
      log.info("COMBO", `Skipping ${modelStr} — provider ${modelProvider} all accounts rate-limited`);
      if (!lastError) lastError = "Provider all accounts rate-limited";
      continue;
    }

    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);
    
    // Smart strategy: skip models that are currently unavailable (circuit OPEN / rate-limited)
    if (comboStrategy === "smart" && !isAvailable(modelStr)) {
      log.info("COMBO", `Skipping ${modelStr} — circuit OPEN or rate-limited`);
      lastError = "Model unavailable (circuit breaker open)";
      continue;
    }
    const attemptStart = Date.now();

    try {
      let result;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        result = await handleSingleModel(body, modelStr);
      } else {
        const timeoutController = new AbortController();
        let timeoutId;
        let timedOut = false;

        const targetSignal = combineSignals(signal, timeoutController.signal);
        const targetOptions = {};
        if (targetSignal) targetOptions.signal = targetSignal;
        if (queueDepth != null) targetOptions.maxQueueSize = queueDepth;

        const timeoutPromise = new Promise((resolve) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            log.warn("COMBO", `Model ${modelStr} exceeded ${timeoutMs}ms timeout — falling back`);
            timeoutController.abort(new Error("combo-per-model-timeout"));
            resolve(
              new Response(
                JSON.stringify({ error: { message: `Model ${modelStr} timed out` } }),
                { status: 524, headers: { "Content-Type": "application/json" } }
              )
            );
          }, timeoutMs);
        });

        try {
          result = await Promise.race([
            Promise.resolve(handleSingleModel(body, modelStr, Object.keys(targetOptions).length > 0 ? targetOptions : undefined)).catch((err) => {
              if (timedOut) {
                // The inner call rejected because we aborted it. The synthetic 524
                // from timeoutPromise already won the race; return an empty response
                // so the loser branch resolves cleanly without leaking err.message.
                return new Response(null, { status: 599 });
              }
              throw err;
            }),
            timeoutPromise,
          ]);
        } finally {
          clearTimeout(timeoutId);
        }
      }

      // Success (2xx) - return response. For streaming the combo sees the
      // response the moment upstream headers + first chunk arrive, so
      // elapsed time is a close proxy for TTFT — pass it through so smart
      // routing prefers fast-prefill models.
      if (result.ok) {
        const elapsedMs = Date.now() - attemptStart;
        recordSuccess(modelStr, elapsedMs, elapsedMs);
        log.info("COMBO", `Model ${modelStr} succeeded`);
        return result;
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      let allRateLimited = false;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
        // True when EVERY account of this provider is locked/rate-limited.
        allRateLimited = errorBody?.allRateLimited === true;
      } catch {
        // Ignore JSON parse errors
      }

      // All accounts of this provider are locked — remember it so the rest of
      // that provider's models in this combo are skipped immediately.
      if (allRateLimited && modelProvider) {
        exhaustedProviders.add(modelProvider);
        log.info("COMBO", `Provider ${modelProvider} all accounts rate-limited — skipping its remaining models`);
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Check if should fallback to next model
      const { shouldFallback, cooldownMs } = checkFallbackError(result.status, errorText);

      if (!shouldFallback) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      // For transient errors (503/502/504), wait for cooldown before falling through
      // so a briefly-overloaded provider gets a chance to recover rather than being
      // skipped immediately (fixes: combo falls through on transient 503)
      if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
          (result.status === 503 || result.status === 502 || result.status === 504)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await new Promise(r => setTimeout(r, cooldownMs));
      }

      // Record failure for health tracking
      const isRateLimit = result.status === 429;
      recordFailure(modelStr, errorText, isRateLimit);
      
      // Fallback to next model
      lastError = errorText || String(result.status);
      if (!lastStatus) lastStatus = result.status;
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues
      lastError = error.message || String(error);
      if (!lastStatus) lastStatus = 500;
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge — it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
};

// Resolve a Response (or {__error}) within ms; the loser keeps running but is ignored.
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); resolve({ __error: e }); });
  });
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs }) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          if (out[i] && out[i].ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning }) {
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // A single-model fusion has nothing to fuse — just answer directly.
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, ...rest } = body;
  const panelBody = { ...rest, stream: false };

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  const t0 = Date.now();
  const calls = panel.map((m) => withTimeout(handleSingleModel(panelBody, m, true), cfg.panelHardTimeoutMs));
  const settled = await collectPanel(calls, { ...cfg, minPanel });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  // 2. Collect successful answers.
  const answers = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) { log.warn("FUSION", `Panel ${model} failed`, { status: res.status }); continue; }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) });
    }
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
    return handleSingleModel(body, answers[0].model);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(judgeBody, judge);
}
