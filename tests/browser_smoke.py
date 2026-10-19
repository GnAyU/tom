"""Optional real Chromium smoke test against --remote-debugging-port=9223.

Uses the environment's websockets package; not needed by unittest or extension.
Launch Chromium with this directory as --load-extension before running.
"""
import json
from pathlib import Path
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from websockets.sync.client import connect

BASE = "http://127.0.0.1:9223"


class CDP:
    def __init__(self, target):
        self.ws = connect(target["webSocketDebuggerUrl"], max_size=10_000_000)
        self.seq = 0

    def call(self, method, **params):
        self.seq += 1
        self.ws.send(json.dumps({"id": self.seq, "method": method, "params": params}))
        while True:
            result = json.loads(self.ws.recv())
            if result.get("id") == self.seq:
                if "error" in result:
                    raise AssertionError(result["error"])
                return result.get("result", {})

    def evaluate(self, expression):
        result = self.call("Runtime.evaluate", expression=expression,
                           awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in result:
            raise AssertionError(result["exceptionDetails"])
        return result["result"].get("value")


def targets():
    return json.load(urllib.request.urlopen(BASE + "/json/list"))


def new_page(url):
    req = urllib.request.Request(BASE + "/json/new?" + url, method="PUT")
    return CDP(json.load(urllib.request.urlopen(req)))


def wait_for(page, expression):
    for _ in range(100):
        try:
            if page.evaluate(expression):
                return
        except AssertionError as error:
            if "execution context" not in str(error).lower():
                raise
        time.sleep(0.1)
    raise AssertionError("Timed out: " + expression)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b'<!doctype html><div class="custom-ad">Custom</div><div class="ad-banner">Generic</div><p>Content</p>')

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    import os
    known_workers = [t for t in targets() if t["type"] == "service_worker" and "background.js" in t["url"]]
    if os.environ.get("OROCHI_EXTENSION_ID"):
        extension = "chrome-extension://" + os.environ["OROCHI_EXTENSION_ID"]
    elif known_workers:
        extension = known_workers[0]["url"].rsplit("/", 1)[0]
    else:
        raise RuntimeError("Worker asleep: set OROCHI_EXTENSION_ID to the ID shown in chrome://extensions")
    page = new_page(extension + "/options.html")
    wait_for(page, 'document.getElementById("status")?.textContent === "设置已加载"')
    state = page.evaluate('chrome.runtime.sendMessage({type:"getSettings"})')
    assert set(state["enabledRulesets"]) == {"easylist", "easylistchina", "easyprivacy"}
    print("PASS extension/options loaded with all three actual rulesets")
    print("Chrome:", page.evaluate('navigator.userAgent'))
    print("Available static rules:", page.evaluate('chrome.declarativeNetRequest.getAvailableStaticRuleCount()'))

    page.evaluate('document.querySelector(\'[data-ruleset="easyprivacy"]\').click()')
    wait_for(page, '!document.getElementById("settings").inert && !document.querySelector(\'[data-ruleset="easyprivacy"]\').checked')
    assert "easyprivacy" not in page.evaluate('chrome.declarativeNetRequest.getEnabledRulesets()')
    page.evaluate('document.querySelector(\'[data-ruleset="easyprivacy"]\').click()')
    wait_for(page, '!document.getElementById("settings").inert && document.querySelector(\'[data-ruleset="easyprivacy"]\').checked')
    print("PASS options ruleset checkboxes update real Chrome DNR state")

    page.evaluate('document.getElementById("domain").value="localhost"; document.getElementById("domainForm").requestSubmit()')
    wait_for(page, 'document.getElementById("domains").textContent.includes("localhost") && !document.getElementById("settings").inert')
    rules = page.evaluate('chrome.declarativeNetRequest.getDynamicRules()')
    assert any(r["condition"].get("urlFilter") == "||localhost^" and r["action"]["type"] == "block" for r in rules)
    page.evaluate('document.getElementById("selectors").value=".custom-ad"; document.getElementById("selectors").dispatchEvent(new Event("input")); document.getElementById("selectorForm").requestSubmit()')
    wait_for(page, '!document.getElementById("settings").inert')
    assert page.evaluate('chrome.storage.local.get("customSelectors")')["customSelectors"] == [".custom-ad"]
    print("PASS options add domain / save selectors persisted and applied")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_port
    site = new_page(f"http://127.0.0.1:{port}/")
    wait_for(site, 'document.querySelector(".custom-ad") && getComputedStyle(document.querySelector(".custom-ad")).display === "none"')
    assert site.evaluate('getComputedStyle(document.querySelector(".ad-banner")).display') == "none"
    fetch = f'fetch("http://localhost:{port}/probe").then(() => "allowed").catch(() => "blocked")'
    assert site.evaluate(fetch) == "blocked"
    print("PASS real request blocked; generic and custom elements hidden")

    tab = page.evaluate(f'chrome.tabs.query({{}}).then(tabs => tabs.find(t => t.url === "http://127.0.0.1:{port}/").id)')
    result = page.evaluate(f'chrome.runtime.sendMessage({{type:"setSitePaused",tabId:{tab},paused:true}})')
    assert result.get("ok"), result
    wait_for(site, 'getComputedStyle(document.querySelector(".custom-ad")).display !== "none"')
    assert site.evaluate(fetch) == "allowed"
    print("PASS site pause installs valid whitelist DNR; request allowed and CSS removed")
    wait_for(page, 'document.getElementById("whitelist").textContent.includes("127.0.0.1")')
    page.evaluate('document.querySelector("#whitelist button").click()')
    wait_for(page, '!document.getElementById("settings").inert && !document.getElementById("whitelist").textContent.includes("127.0.0.1")')
    wait_for(site, 'getComputedStyle(document.querySelector(".custom-ad")).display === "none"')
    assert site.evaluate(fetch) == "blocked"
    print("PASS options whitelist removal restores blocking and hiding")

    assert not page.evaluate('chrome.runtime.sendMessage({type:"setEnabled",enabled:false})').get("error")
    assert page.evaluate('chrome.declarativeNetRequest.getEnabledRulesets()') == []
    assert not any(r["id"] == 100000 for r in page.evaluate('chrome.declarativeNetRequest.getDynamicRules()'))
    wait_for(site, 'getComputedStyle(document.querySelector(".custom-ad")).display !== "none"')
    assert site.evaluate(fetch) == "allowed"
    assert not page.evaluate('chrome.runtime.sendMessage({type:"setEnabled",enabled:true})').get("error")
    wait_for(site, 'getComputedStyle(document.querySelector(".custom-ad")).display === "none"')
    assert site.evaluate(fetch) == "blocked"
    print("PASS global off/on controls static + custom network rules and cosmetic CSS")

    page.evaluate('document.querySelector("#domains button").click()')
    wait_for(page, '!document.getElementById("settings").inert && !document.getElementById("domains").textContent.includes("localhost")')
    assert site.evaluate(fetch) == "allowed"
    page.evaluate('document.getElementById("selectors").value=""; document.getElementById("selectors").dispatchEvent(new Event("input")); document.getElementById("selectorForm").requestSubmit()')
    wait_for(page, '!document.getElementById("settings").inert')
    wait_for(site, 'getComputedStyle(document.querySelector(".custom-ad")).display !== "none"')
    assert page.evaluate('chrome.storage.local.get("customSelectors")')["customSelectors"] == []
    print("PASS options delete domain / selectors updates existing page immediately")

    popup = new_page(extension + "/popup.html")
    wait_for(popup, 'document.getElementById("options") !== null')
    popup.evaluate('document.getElementById("options").click()')
    time.sleep(0.3)
    assert any(t["url"] == extension + "/options.html" for t in targets())
    print("PASS popup settings button opens options page")
    server.shutdown()
    print("BROWSER SMOKE: ALL CHECKS PASSED")
