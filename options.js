// Orochi AdBlock — options; mutations are serialized by the service worker.
(async function () {
  const status = document.getElementById("status");
  const settings = document.getElementById("settings");
  const selectors = document.getElementById("selectors");
  let busy = false;
  let selectorsDirty = false;

  async function request(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result || result.error) throw new Error(result?.error || "无法连接后台服务");
    return result;
  }

  function showStatus(message, error = false) {
    status.textContent = message;
    status.dataset.error = String(error);
  }

  function renderList(id, values, empty, remove) {
    const list = document.getElementById(id);
    list.replaceChildren();
    if (!values.length) {
      const item = document.createElement("li");
      item.textContent = empty;
      list.appendChild(item);
    }
    for (const value of values) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = value;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "移除";
      button.setAttribute("aria-label", `移除 ${value}`);
      button.addEventListener("click", () => remove(value));
      item.append(label, button);
      list.appendChild(item);
    }
  }

  function render(state) {
    renderList("whitelist", state.whitelist, "没有已暂停的站点", (hostname) =>
      mutate({ type: "removeWhitelistHost", hostname }));
    renderList("domains", state.customBlockedDomains, "尚未添加自定义域名", (domain) =>
      mutate({ type: "removeBlockedDomain", domain }));
    for (const input of document.querySelectorAll("[data-ruleset]")) {
      input.checked = state.enabledRulesets.includes(input.dataset.ruleset);
      input.disabled = !state.enabled;
    }
    document.getElementById("rulesetHint").textContent = state.enabled
      ? "勾选状态来自浏览器实际启用的规则集；修改立即生效。"
      : `全局已暂停，当前全部停用。恢复后启用：${state.selectedRulesets.join("、") || "无"}。请先在弹窗恢复全局开关。`;
    if (!selectorsDirty) selectors.value = state.customSelectors.join("\n");
  }

  async function refresh() {
    render(await request({ type: "getSettings" }));
  }

  async function mutate(message) {
    if (busy) return false;
    busy = true;
    settings.inert = true;
    try {
      const state = await request(message);
      render(state);
      showStatus("设置已保存并应用");
      return true;
    } catch (error) {
      showStatus(error.message, true);
      try { await refresh(); } catch { /* retain the original error */ }
      return false;
    } finally {
      busy = false;
      settings.inert = false;
    }
  }

  for (const input of document.querySelectorAll("[data-ruleset]")) {
    input.addEventListener("change", () => mutate({
      type: "setRulesetEnabled", rulesetId: input.dataset.ruleset, enabled: input.checked,
    }));
  }
  document.getElementById("domainForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("domain");
    try {
      const domain = OrochiRules.normalizeDomain(input.value);
      if (await mutate({ type: "addBlockedDomain", domain })) input.value = "";
    } catch (error) {
      showStatus(error.message, true);
    }
  });
  selectors.addEventListener("input", () => { selectorsDirty = true; });
  document.getElementById("selectorForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = OrochiRules.normalizeSelectors(selectors.value);
    for (const selector of values) {
      try { document.querySelector(selector); } catch {
        showStatus(`无效的 CSS 选择器：${selector}`, true);
        return;
      }
    }
    if (await mutate({ type: "setCustomSelectors", selectors: values })) {
      selectorsDirty = false;
      selectors.value = values.join("\n");
    }
  });

  // Refresh other windows' changes, without overwriting an unsaved selector draft.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && !busy && [
      "enabled", "whitelist", "selectedRulesets", "customBlockedDomains", "customSelectors",
    ].some((key) => changes[key])) refresh().catch((error) => showStatus(error.message, true));
  });
  window.addEventListener("focus", () => {
    if (!busy) refresh().catch((error) => showStatus(error.message, true));
  });
  try {
    await refresh();
    settings.inert = false;
    showStatus("设置已加载");
  } catch (error) {
    showStatus(error.message, true);
  }
})();
