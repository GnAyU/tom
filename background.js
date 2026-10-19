// Orochi AdBlock — service worker
importScripts("rules.js");
const { RULESETS, CUSTOM_RULE_BASE, CUSTOM_RULE_LIMIT, WHITELIST_RULE_BASE } = OrochiRules;
const tabCounts = new Map();
let settingsQueue = Promise.resolve();
let counterQueue = Promise.resolve();

async function getEnabled() {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  return enabled;
}

async function applyEnabled(enabled) {
  const { selectedRulesets } = await chrome.storage.local.get({ selectedRulesets: RULESETS });
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enabled ? RULESETS.filter((id) => selectedRulesets.includes(id)) : [],
    disableRulesetIds: RULESETS.filter((id) => !enabled || !selectedRulesets.includes(id)),
  });
  await rebuildCustomRules();
  if (!enabled) {
    for (const tabId of tabCounts.keys()) setBadge(tabId, 0);
    tabCounts.clear();
  }
}

function setBadge(tabId, count) {
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
}

// This ID range is reserved for our dynamic whitelist rules.
function isWhitelistRule(rule) {
  return rule.rulesetId === "_dynamic" && rule.ruleId >= WHITELIST_RULE_BASE;
}

async function rebuildWhitelist() {
  const { whitelist } = await chrome.storage.local.get({ whitelist: [] });
  const hosts = [...new Set(whitelist)];
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.filter((rule) => rule.id >= WHITELIST_RULE_BASE)
      .map((rule) => rule.id),
    addRules: hosts.flatMap((host, index) => [
      {
        id: WHITELIST_RULE_BASE + index * 2,
        priority: 1000,
        action: { type: "allowAllRequests" },
        // allowAllRequests only supports frame resource types. Matching the
        // destination also allows the site's initial navigation and its frames.
        condition: { requestDomains: [host], resourceTypes: ["main_frame", "sub_frame"] },
      },
      {
        id: WHITELIST_RULE_BASE + index * 2 + 1,
        priority: 1000,
        action: { type: "allow" },
        condition: { initiatorDomains: [host] },
      },
    ]),
  });
}

async function rebuildCustomRules() {
  const { enabled, customBlockedDomains } = await chrome.storage.local.get({
    enabled: true, customBlockedDomains: [],
  });
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.filter((rule) =>
      rule.id >= CUSTOM_RULE_BASE && rule.id < CUSTOM_RULE_LIMIT).map((rule) => rule.id),
    addRules: enabled ? OrochiRules.buildBlockRules(customBlockedDomains) : [],
  });
}

// All popup/options mutations share one queue, including whitelist removals.
function queueSettings(task) {
  const operation = settingsQueue.then(task);
  settingsQueue = operation.catch((error) => console.error("Settings update failed", error));
  return operation;
}

async function changeWhitelist(hostname, paused) {
  const { whitelist } = await chrome.storage.local.get({ whitelist: [] });
  const hosts = paused ? [...new Set([...whitelist, hostname])]
    : OrochiRules.removeWhitelistHost(whitelist, hostname);
  await chrome.storage.local.set({ whitelist: hosts });
  try {
    await rebuildWhitelist();
  } catch (error) {
    await chrome.storage.local.set({ whitelist });
    throw error;
  }
}

async function saveNetworkSettings(patch) {
  const previous = await chrome.storage.local.get({
    enabled: true, selectedRulesets: RULESETS, customBlockedDomains: [],
  });
  await chrome.storage.local.set(patch);
  try {
    await applyEnabled(await getEnabled());
  } catch (error) {
    await chrome.storage.local.set(previous);
    await applyEnabled(previous.enabled);
    throw error;
  }
}

function siteHostname(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.hostname : "";
  } catch {
    return "";
  }
}

// Debug matches are available for unpacked extensions. Allow rules are not blocks.
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    if (isWhitelistRule(info.rule)) return;
    counterQueue = counterQueue.then(async () => {
      const { totalBlocked } = await chrome.storage.local.get({ totalBlocked: 0 });
      await chrome.storage.local.set({ totalBlocked: totalBlocked + 1 });
    }).catch((error) => console.error("Counter update failed", error));
    const tabId = info.request.tabId;
    if (tabId < 0) return;
    const n = (tabCounts.get(tabId) || 0) + 1;
    tabCounts.set(tabId, n);
    setBadge(tabId, n);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => tabCounts.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabCounts.set(tabId, 0);
    setBadge(tabId, 0);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.whitelist) queueSettings(rebuildWhitelist);
  if (changes.customBlockedDomains || changes.enabled || changes.selectedRulesets) {
    queueSettings(async () => applyEnabled(await getEnabled()));
  }
});

async function getSettings() {
  const stored = await chrome.storage.local.get({
    enabled: true, whitelist: [], customBlockedDomains: [],
    customSelectors: [], selectedRulesets: RULESETS,
  });
  return { ...stored, enabledRulesets: await chrome.declarativeNetRequest.getEnabledRulesets() };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || ![
    "getState", "setEnabled", "setSitePaused", "getSettings", "removeWhitelistHost",
    "setRulesetEnabled", "addBlockedDomain", "removeBlockedDomain", "setCustomSelectors",
  ].includes(msg.type)) return;
  queueSettings(async () => {
    if (msg.type === "getSettings") return getSettings();
    if (msg.type === "getState") {
      await counterQueue;
      const enabled = await getEnabled();
      const { totalBlocked, whitelist } = await chrome.storage.local.get({
        totalBlocked: 0, whitelist: [],
      });
      const tab = await chrome.tabs.get(msg.tabId);
      const hostname = siteHostname(tab.url);
      let count = tabCounts.get(msg.tabId) || 0;
      if (count === 0 && chrome.declarativeNetRequest.getMatchedRules) {
        try {
          const res = await chrome.declarativeNetRequest.getMatchedRules({
            tabId: msg.tabId, minTimeStamp: Date.now() - 30 * 60 * 1000,
          });
          count = (res.rulesMatchedInfo || [])
            .filter((match) => !isWhitelistRule(match.rule)).length;
        } catch {
          /* tab may be gone; ignore */
        }
      }
      return { enabled, count, totalBlocked, hostname, paused: whitelist.includes(hostname) };
    }
    if (msg.type === "setEnabled") {
      await saveNetworkSettings({ enabled: Boolean(msg.enabled) });
      return { ok: true };
    }
    if (msg.type === "setSitePaused") {
      const tab = await chrome.tabs.get(msg.tabId);
      const hostname = siteHostname(tab.url);
      if (!hostname) throw new Error("Only HTTP(S) sites can be paused");
      await changeWhitelist(hostname, Boolean(msg.paused));
      return { ok: true, hostname, paused: Boolean(msg.paused) };
    }
    if (msg.type === "removeWhitelistHost") {
      await changeWhitelist(msg.hostname, false);
    } else if (msg.type === "setRulesetEnabled") {
      if (!RULESETS.includes(msg.rulesetId)) throw new Error("未知规则集");
      const { enabled, selectedRulesets, enabledRulesets } = await getSettings();
      const selected = new Set(enabled ? enabledRulesets : selectedRulesets);
      if (msg.enabled) selected.add(msg.rulesetId);
      else selected.delete(msg.rulesetId);
      await saveNetworkSettings({ selectedRulesets: RULESETS.filter((id) => selected.has(id)) });
    } else if (["addBlockedDomain", "removeBlockedDomain"].includes(msg.type)) {
      const domain = OrochiRules.normalizeDomain(msg.domain);
      const { customBlockedDomains } = await chrome.storage.local.get({ customBlockedDomains: [] });
      const domains = msg.type === "addBlockedDomain"
        ? [...new Set([...customBlockedDomains, domain])]
        : customBlockedDomains.filter((host) => host !== domain);
      OrochiRules.buildBlockRules(domains);
      await saveNetworkSettings({ customBlockedDomains: domains });
    } else if (msg.type === "setCustomSelectors") {
      await chrome.storage.local.set({ customSelectors: OrochiRules.normalizeSelectors(msg.selectors) });
    }
    return getSettings();
  }).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});

// Top-level initialization covers install, browser startup and worker restarts.
queueSettings(async () => {
  await applyEnabled(await getEnabled());
  await rebuildWhitelist();
});
