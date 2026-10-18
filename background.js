// Orochi AdBlock — service worker
// - Tracks per-tab blocked counts via onRuleMatchedDebug (works for
//   unpacked / developer-mode installs) with a getMatchedRules fallback.
// - Handles the global on/off toggle by enabling/disabling rulesets.

const RULESETS = ["easylist", "easylistchina", "easyprivacy"];
const tabCounts = new Map();

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

// Fires for unpacked extensions; harmless no-op in packed installs.
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getState") {
    (async () => {
      const enabled = await getEnabled();
      let count = tabCounts.get(msg.tabId) || 0;
      // Fallback: ask the API what matched recently for this tab.
      if (count === 0 && chrome.declarativeNetRequest.getMatchedRules) {
        try {
          const res = await chrome.declarativeNetRequest.getMatchedRules({
            tabId: msg.tabId,
            minTimeStamp: Date.now() - 30 * 60 * 1000,
          });
          count = res.rulesMatchedInfo ? res.rulesMatchedInfo.length : 0;
        } catch (e) {
          /* tab may be gone; ignore */
        }
      }
      sendResponse({ enabled, count });
    })();
    return true;
  }
  if (msg.type === "setEnabled") {
    (async () => {
      await chrome.storage.local.set({ enabled: msg.enabled });
      await applyEnabled(msg.enabled);
      sendResponse({ ok: true });
    })();
    return true;
  }
});

// Restore the saved toggle state on startup.
getEnabled().then(applyEnabled);
