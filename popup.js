// Orochi AdBlock — popup logic
(async function () {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const countEl = document.getElementById("count");
  const toggle = document.getElementById("toggle");
  const stateText = document.getElementById("stateText");
  if (!tab) return;

  const state = await chrome.runtime.sendMessage({
    type: "getState",
    tabId: tab.id,
  });
  if (state) {
    countEl.textContent = state.enabled ? String(state.count) : "0";
    toggle.checked = state.enabled;
    stateText.textContent = state.enabled ? "拦截中" : "已暂停";
  }

  toggle.addEventListener("change", async () => {
    await chrome.runtime.sendMessage({
      type: "setEnabled",
      enabled: toggle.checked,
    });
    stateText.textContent = toggle.checked ? "拦截中" : "已暂停";
    if (!toggle.checked) countEl.textContent = "0";
  });
})();
