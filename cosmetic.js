// Orochi AdBlock — generic cosmetic filtering.
// Hides common ad containers with a small, curated selector list
// (generic EasyList-style hides that are safe across most sites).
(async function () {
  const SELECTORS = [
    '[id^="ad-"]', '[id^="ads-"]', '[id^="google_ads"]',
    '[class^="ad-"]', '[class*=" ad-"]', '[class*="-ad-"]',
    ".adsbygoogle", ".ad-banner", ".ad-container", ".ad-wrapper",
    ".advertisement", ".banner-ad", ".sponsored-post",
    'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication.com"]',
    'iframe[src*="amazon-adsystem.com"]', 'div[id*="baidu"] > .ec_ad',
    ".ad-slot", ".ads-slot", "#ads", ".gg-ad", ".top-ad", ".bottom-ad"
  ];
  const style = document.createElement("style");
  style.id = "orochi-adblock-cosmetic";

  function validSelector(selector) {
    try {
      document.querySelector(selector);
      return true;
    } catch {
      return false;
    }
  }

  async function render() {
    const { enabled, whitelist, customSelectors } = await chrome.storage.local.get({
      enabled: true, whitelist: [], customSelectors: [],
    });
    style.textContent = !enabled || whitelist.includes(location.hostname) ? ""
      : OrochiRules.cosmeticCSS([...SELECTORS, ...customSelectors], validSelector);
    if (!style.isConnected && style.textContent) {
      (document.head || document.documentElement).appendChild(style);
    }
  }

  // Re-read the latest storage state on every change (including site pause).
  let renderQueue = Promise.resolve();
  function refresh() {
    renderQueue = renderQueue.then(render).catch(console.error);
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (changes.whitelist || changes.enabled || changes.customSelectors)) {
      refresh();
    }
  });
  refresh();
})();
