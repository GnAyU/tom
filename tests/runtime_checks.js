// Node-only test harness: executes the shipped scripts, with a small Chrome mock.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.join(__dirname, "..");
const source = (name) => fs.readFileSync(path.join(root, name), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function setup(initial = {}, dynamic = []) {
  const state = { ...initial };
  const listeners = {};
  const errors = [];
  let enabledRulesets = ["easylist", "easylistchina", "easyprivacy"];
  let failNext = false;
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const chrome = {
    storage: {
      local: {
        get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
          [key, key in state ? state[key] : value])),
        set: async (patch) => {
          const changes = {};
          for (const [key, value] of Object.entries(patch)) {
            if (JSON.stringify(state[key]) !== JSON.stringify(value)) {
              changes[key] = { oldValue: state[key], newValue: value };
              state[key] = plain(value);
            }
          }
          if (Object.keys(changes).length) listeners.storage?.(changes, "local");
        },
      },
      onChanged: event("storage"),
    },
    declarativeNetRequest: {
      getEnabledRulesets: async () => [...enabledRulesets],
      updateEnabledRulesets: async ({ enableRulesetIds = [], disableRulesetIds = [] }) => {
        enabledRulesets = [...new Set([...enabledRulesets.filter((id) =>
          !disableRulesetIds.includes(id)), ...enableRulesetIds])];
      },
      getDynamicRules: async () => plain(dynamic),
      updateDynamicRules: async ({ removeRuleIds, addRules }) => {
        if (failNext) { failNext = false; throw new Error("mock quota exceeded"); }
        for (const rule of addRules) {
          if (rule.action.type === "allowAllRequests") {
            assert.ok(rule.condition.resourceTypes.every((type) => ["main_frame", "sub_frame"].includes(type)));
          }
        }
        dynamic = [...dynamic.filter((rule) => !removeRuleIds.includes(rule.id)), ...plain(addRules)];
        assert.equal(new Set(dynamic.map((rule) => rule.id)).size, dynamic.length);
      },
      onRuleMatchedDebug: event("matched"),
      getMatchedRules: async () => ({ rulesMatchedInfo: [] }),
    },
    tabs: { get: async () => ({ url: "https://site.example/page" }),
      onRemoved: event("removed"), onUpdated: event("updated") },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    runtime: { onMessage: event("message") },
  };
  const context = vm.createContext({ chrome, URL, console: { error: (...args) => errors.push(args) } });
  context.importScripts = (name) => vm.runInContext(source(name), context);
  vm.runInContext(source("background.js"), context);
  const rules = vm.runInContext("OrochiRules", context);
  const flush = async () => { await tick(); await vm.runInContext("settingsQueue", context); await tick(); };
  await flush();
  const send = (message) => new Promise((resolve) => {
    assert.equal(listeners.message(message, {}, resolve), true);
  });
  return { state, rules, send, flush, chrome, listeners, errors, context,
    dynamic: () => plain(dynamic), enabled: () => [...enabledRulesets],
    fail: () => { failNext = true; },
    realEnabled: (ids) => { enabledRulesets = ids; } };
}

const cases = {
  async block_rules() {
    const app = await setup();
    const rules = plain(app.rules.buildBlockRules([" Ads.Example. ", "ads.example", "例子.测试"]));
    assert.deepEqual(rules.map((r) => r.id), [100000, 100001]);
    assert.deepEqual(rules[0], { id: 100000, priority: 10,
      action: { type: "block" }, condition: { urlFilter: "||ads.example^" } });
    assert.equal(rules[1].condition.urlFilter, "||xn--fsqu00a.xn--0zwm56d^");
    assert.deepEqual(plain(app.rules.buildBlockRules([])), []);
  },
  async invalid_domains() {
    const { rules } = await setup();
    for (const domain of ["", "https://ads.example", "ads.example/path", "*.example", "a b", "a..b", "-a.test", "x:80"]) {
      assert.throws(() => rules.normalizeDomain(domain), undefined, domain);
    }
  },
  async whitelist_remove_pure() {
    const { rules } = await setup();
    const original = ["a.example", "b.example", "a.example"];
    assert.deepEqual(plain(rules.removeWhitelistHost(original, "a.example")), ["b.example"]);
    assert.equal(original.length, 3);
    assert.deepEqual(plain(rules.removeWhitelistHost(original, "missing")), original);
  },
  async selectors_pure() {
    const { rules } = await setup();
    assert.deepEqual(plain(rules.normalizeSelectors(" .ad \r\n#slot\n\n.ad\n")), [".ad", "#slot"]);
    assert.deepEqual(plain(rules.normalizeSelectors([" .ad ", "#slot", ".ad"])), [".ad", "#slot"]);
    const css = rules.cosmeticCSS([".ad", "[bad", "#slot"], (s) => s !== "[bad");
    assert.equal(css, ".ad {\n  display: none !important;\n  visibility: hidden !important;\n}\n#slot {\n  display: none !important;\n  visibility: hidden !important;\n}");
  },
  async startup_sync() {
    const foreign = { id: 42, action: { type: "block" }, condition: { urlFilter: "other" } };
    const app = await setup({ whitelist: ["site.example"], customBlockedDomains: ["ads.example"] }, [
      foreign, { id: 100999 }, { id: 1000500 },
    ]);
    assert.deepEqual(app.dynamic().map((r) => r.id).sort((a, b) => a - b), [42, 100000, 1000000, 1000001]);
    assert.deepEqual(app.dynamic().find((r) => r.id === 42), foreign);
    assert.equal(app.errors.length, 0);
  },
  async whitelist_remove_message() {
    const app = await setup({ whitelist: ["site.example", "keep.example"], totalBlocked: 89 });
    const result = await app.send({ type: "removeWhitelistHost", hostname: "site.example" });
    assert.deepEqual(result.whitelist, ["keep.example"]);
    assert.equal(app.state.totalBlocked, 89);
    assert.equal(app.dynamic().length, 2);
    assert.equal(app.dynamic()[0].condition.requestDomains[0], "keep.example");
    const state = await app.send({ type: "getState", tabId: 1 });
    assert.equal(state.paused, false);
  },
  async concurrent_mutations() {
    const app = await setup({ whitelist: ["old.example"] });
    await Promise.all([
      app.send({ type: "setSitePaused", tabId: 1, paused: true }),
      app.send({ type: "removeWhitelistHost", hostname: "old.example" }),
      app.send({ type: "addBlockedDomain", domain: "one.example" }),
      app.send({ type: "addBlockedDomain", domain: "two.example" }),
    ]);
    await app.flush();
    assert.deepEqual(app.state.whitelist, ["site.example"]);
    assert.deepEqual(app.state.customBlockedDomains, ["one.example", "two.example"]);
    assert.equal(app.dynamic().length, 4);
  },
  async domain_add_remove() {
    const app = await setup();
    for (const domain of ["ADS.example", "ads.example"]) {
      assert.ok(!(await app.send({ type: "addBlockedDomain", domain })).error);
    }
    assert.deepEqual(app.state.customBlockedDomains, ["ads.example"]);
    assert.equal(app.dynamic()[0].condition.urlFilter, "||ads.example^");
    await app.send({ type: "removeBlockedDomain", domain: "ads.example" });
    assert.deepEqual(app.state.customBlockedDomains, []);
    assert.deepEqual(app.dynamic(), []);
  },
  async selectors_storage() {
    const app = await setup({ whitelist: ["keep.example"], totalBlocked: 123 });
    await app.send({ type: "setCustomSelectors", selectors: " .ad \n#slot\n.ad\n" });
    assert.deepEqual(app.state.customSelectors, [".ad", "#slot"]);
    assert.deepEqual((await app.send({ type: "getSettings" })).customSelectors, [".ad", "#slot"]);
    await app.send({ type: "setCustomSelectors", selectors: "" });
    assert.deepEqual(app.state.customSelectors, []);
    assert.deepEqual(app.state.whitelist, ["keep.example"]);
    assert.equal(app.state.totalBlocked, 123);
  },
  async global_and_rulesets() {
    const app = await setup({ customBlockedDomains: ["ads.example"] });
    await app.send({ type: "setRulesetEnabled", rulesetId: "easyprivacy", enabled: false });
    assert.deepEqual(app.enabled(), ["easylist", "easylistchina"]);
    await app.send({ type: "setEnabled", enabled: false });
    assert.deepEqual(app.enabled(), []);
    assert.deepEqual(app.dynamic(), []);
    assert.deepEqual(app.state.customBlockedDomains, ["ads.example"]);
    await app.send({ type: "setEnabled", enabled: true });
    assert.deepEqual(app.enabled(), ["easylist", "easylistchina"]);
    assert.equal(app.dynamic().length, 1);
    await app.flush();
    app.realEnabled(["easyprivacy"]);
    assert.deepEqual((await app.send({ type: "getSettings" })).enabledRulesets, ["easyprivacy"]);
    const restarted = await setup(app.state);
    assert.deepEqual(restarted.enabled(), ["easylist", "easylistchina"]);
  },
  async rollback_and_recovery() {
    const app = await setup();
    app.fail();
    assert.match((await app.send({ type: "addBlockedDomain", domain: "fail.example" })).error, /quota/);
    assert.deepEqual(app.state.customBlockedDomains, []);
    assert.ok(!(await app.send({ type: "addBlockedDomain", domain: "good.example" })).error);
    assert.equal(app.dynamic()[0].condition.urlFilter, "||good.example^");
    await app.flush();
    app.fail();
    assert.match((await app.send({ type: "setSitePaused", tabId: 1, paused: true })).error, /quota/);
    assert.deepEqual(app.state.whitelist, []);
    await app.flush();
  },
  async counter_compatibility() {
    const app = await setup({ totalBlocked: 7, whitelist: ["site.example"] });
    app.listeners.matched({ rule: { rulesetId: "_dynamic", ruleId: 1000000 }, request: { tabId: 1 } });
    for (let i = 0; i < 3; i++) app.listeners.matched({
      rule: { rulesetId: "_dynamic", ruleId: 100000 }, request: { tabId: 1 },
    });
    const state = await app.send({ type: "getState", tabId: 1 });
    assert.equal(state.totalBlocked, 10);
    assert.equal(state.count, 3);
    assert.equal(state.paused, true);
    app.listeners.updated(1, { status: "loading" });
    assert.equal((await app.send({ type: "getState", tabId: 1 })).count, 0);
  },
  async cosmetic_live() {
    const app = await setup({ customSelectors: [".custom-ad", "[bad"] });
    const styles = [];
    const style = { textContent: "", isConnected: false };
    const document = {
      createElement: () => style,
      querySelector: (s) => { if (s === "[bad") throw new Error("invalid"); return null; },
      head: { appendChild: (s) => { styles.push(s); s.isConnected = true; } },
    };
    const context = vm.createContext({ chrome: app.chrome, document,
      location: { hostname: "site.example" }, console });
    vm.runInContext(source("rules.js"), context);
    vm.runInContext(source("cosmetic.js"), context);
    await tick();
    assert.match(style.textContent, /\.custom-ad \{/);
    assert.match(style.textContent, /\.adsbygoogle \{/);
    assert.ok(!style.textContent.includes("[bad"));
    await app.chrome.storage.local.set({ whitelist: ["site.example"] });
    await tick();
    assert.equal(style.textContent, "");
    await app.chrome.storage.local.set({ whitelist: [], customSelectors: ["#replacement"] });
    await tick();
    assert.match(style.textContent, /#replacement/);
    assert.ok(!style.textContent.includes(".custom-ad"));
    await app.chrome.storage.local.set({ enabled: false });
    await tick();
    assert.equal(style.textContent, "");
    assert.equal(styles.length, 1);
  },
  async popup_options() {
    const elements = Object.fromEntries(["options", "count", "totalBlocked", "toggle", "stateText", "siteToggle", "siteHint"].map((id) =>
      [id, { addEventListener(type, fn) { this[type] = fn; } }]));
    let opened = 0;
    const context = vm.createContext({
      document: { getElementById: (id) => elements[id] },
      chrome: { tabs: { query: async () => [] }, runtime: { openOptionsPage: async () => { opened++; } } },
    });
    vm.runInContext(source("popup.js"), context);
    await tick();
    elements.options.click();
    await tick();
    assert.equal(opened, 1);
  },
};
(async () => {
  const name = process.argv[2];
  assert.ok(cases[name], `Unknown check: ${name}`);
  await cases[name]();
  console.log(`PASS ${name}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
