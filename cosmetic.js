// Orochi AdBlock — generic cosmetic filtering.
// Hides common ad containers with a small, curated selector list
// (generic EasyList-style hides that are safe across most sites).
(async function () {
  const { whitelist } = await chrome.storage.local.get({ whitelist: [] });
  if (whitelist.includes(location.hostname)) return;

  const SELECTORS = [
    '[id^="ad-"]', '[id^="ads-"]', '[id^="google_ads"]',
    '[class^="ad-"]', '[class*=" ad-"]', '[class*="-ad-"]',
    ".adsbygoogle", ".ad-banner", ".ad-container", ".ad-wrapper",
    ".advertisement", ".banner-ad", ".sponsored-post",
    'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication.com"]',
    'iframe[src*="amazon-adsystem.com"]', 'div[id*="baidu"] > .ec_ad',
    ".ad-slot", ".ads-slot", "#ads", ".gg-ad", ".top-ad", ".bottom-ad"
  ];
  const css =
    SELECTORS.join(",\n") +
    " {\n  display: none !important;\n  visibility: hidden !important;\n}";
  const style = document.createElement("style");
  style.id = "orochi-adblock-cosmetic";
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
})();
