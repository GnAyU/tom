// Orochi AdBlock — popup logic; all state changes go through the service worker.
(async function () {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const countEl = document.getElementById("count");
  const totalEl = document.getElementById("totalBlocked");
  const toggle = document.getElementById("toggle");
  const stateText = document.getElementById("stateText");
  const siteToggle = document.getElementById("siteToggle");
  const siteHint = document.getElementById("siteHint");
  if (!tab) return;

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || response.error) {
      throw new Error(response?.error || "无法连接后台服务");
    }
    return response;
  }

  let paused = false;
  function renderSite() {
    siteToggle.textContent = paused ? "恢复此站点拦截" : "暂停此站点拦截";
    stateText.textContent = !toggle.checked ? "已暂停" : paused ? "此站点已暂停" : "拦截中";
  }

  try {
    const state = await request({ type: "getState", tabId: tab.id });
    countEl.textContent = state.enabled ? String(state.count) : "0";
    totalEl.textContent = String(state.totalBlocked);
    toggle.checked = state.enabled;
    paused = state.paused;
    siteToggle.disabled = !state.hostname;
    siteToggle.title = state.hostname || "仅支持 HTTP(S) 站点";
    renderSite();
  } catch (error) {
    siteHint.textContent = error.message;
    return;
  }

  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      await request({ type: "setEnabled", enabled: toggle.checked });
      if (!toggle.checked) countEl.textContent = "0";
    } catch (error) {
      toggle.checked = !toggle.checked;
      siteHint.textContent = error.message;
    } finally {
      renderSite();
      toggle.disabled = false;
    }
  });

  siteToggle.addEventListener("click", async () => {
    siteToggle.disabled = true;
    try {
      const result = await request({ type: "setSitePaused", tabId: tab.id, paused: !paused });
      paused = result.paused;
      renderSite();
      siteHint.textContent = "刷新页面后元素隐藏设置生效";
    } catch (error) {
      siteHint.textContent = error.message;
    } finally {
      siteToggle.disabled = false;
    }
  });
})();
