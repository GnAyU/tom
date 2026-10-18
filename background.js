// Orochi AdBlock — service worker
const RULESETS = ["easylist", "easylistchina", "easyprivacy"];
const WHITELIST_RULE_BASE = 1000000;
const RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "media", "websocket", "webtransport", "other",
];
const tabCounts = new Map();
let whitelistQueue = Promise.resolve();
let counterQueue = Promise.resolve();

async function getEnabled() {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  return enabled;
}

async function applyEnabled(enabled) {
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    enabled
      ? { enableRulesetIds: RULESETS }
      : { disableRulesetIds: RULESETS }
  );
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
    addRules: hosts.map((host, index) => ({
      id: WHITELIST_RULE_BASE + index,
      priority: 1000,
      action: { type: "allowAllRequests" },
      condition: { initiatorDomains: [host], resourceTypes: RESOURCE_TYPES },
    })),
  });
}

// Serialize rebuilds and popup mutations so rapid changes cannot overwrite each other.
function queueWhitelist(task = rebuildWhitelist) {
  const operation = whitelistQueue.then(task);
  whitelistQueue = operation.catch((error) => console.error("Whitelist update failed", error));
  return operation;
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
    // Serialize read/modify/write operations, including events without a tab.
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
  if (areaName === "local" && changes.whitelist) queueWhitelist();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!["getState", "setEnabled", "setSitePaused"].includes(msg.type)) return;
  (async () => {
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
            tabId: msg.tabId,
            minTimeStamp: Date.now() - 30 * 60 * 1000,
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
      await chrome.storage.local.set({ enabled: msg.enabled });
      await applyEnabled(msg.enabled);
      return { ok: true };
    }
    const tab = await chrome.tabs.get(msg.tabId);
    const hostname = siteHostname(tab.url);
    if (!hostname) throw new Error("Only HTTP(S) sites can be paused");
    await queueWhitelist(async () => {
      const { whitelist } = await chrome.storage.local.get({ whitelist: [] });
      const hosts = new Set(whitelist);
      if (msg.paused) hosts.add(hostname);
      else hosts.delete(hostname);
      await chrome.storage.local.set({ whitelist: [...hosts] });
      await rebuildWhitelist();
    });
    return { ok: true, hostname, paused: Boolean(msg.paused) };
  })().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});

// Service-worker initialization also runs after browser/extension restarts.
getEnabled().then(applyEnabled).catch(console.error);
queueWhitelist();
