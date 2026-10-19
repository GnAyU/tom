// Orochi AdBlock — shared, side-effect-free settings helpers.
const OrochiRules = (() => {
  const RULESETS = ["easylist", "easylistchina", "easyprivacy"];
  const CUSTOM_RULE_BASE = 100000;
  const CUSTOM_RULE_LIMIT = 130000;
  const WHITELIST_RULE_BASE = 1000000;

  function normalizeDomain(value) {
    const domain = String(value).trim().toLowerCase().replace(/\.$/, "");
    if (!domain || /[\s/:?#@*^|\\%]/.test(domain)) {
      throw new Error("请输入域名，不要包含协议、路径或通配符");
    }
    const hostname = new URL(`https://${domain}`).hostname;
    if (hostname.length > 253 || !hostname.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error("域名格式无效");
    }
    return hostname;
  }

  function buildBlockRules(domains) {
    const hosts = [...new Set(domains.map(normalizeDomain))];
    if (hosts.length > CUSTOM_RULE_LIMIT - CUSTOM_RULE_BASE) {
      throw new Error("自定义域名数量超过保留规则区间");
    }
    return hosts.map((host, index) => ({
      id: CUSTOM_RULE_BASE + index,
      priority: 10,
      action: { type: "block" },
      condition: { urlFilter: `||${host}^` },
    }));
  }

  function removeWhitelistHost(whitelist, hostname) {
    return whitelist.filter((host) => host !== hostname);
  }

  function normalizeSelectors(value) {
    const lines = Array.isArray(value) ? value : String(value).split(/\r?\n/);
    return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
  }

  function cosmeticCSS(selectors, isValid) {
    // Keep selectors separate: an unsupported selector must not cancel others.
    return normalizeSelectors(selectors).filter(isValid).map((selector) =>
      `${selector} {\n  display: none !important;\n  visibility: hidden !important;\n}`
    ).join("\n");
  }

  return {
    RULESETS, CUSTOM_RULE_BASE, CUSTOM_RULE_LIMIT, WHITELIST_RULE_BASE,
    normalizeDomain, buildBlockRules, removeWhitelistHost,
    normalizeSelectors, cosmeticCSS,
  };
})();
