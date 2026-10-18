#!/usr/bin/env python3
"""Convert Adblock Plus filter lists (network rules) to Chrome
declarativeNetRequest static ruleset JSON.

Usage: convert.py <input.txt> <output.json>
Cosmetic rules (##) are skipped (handled separately by a content script).
Rules using unsupported options are skipped and counted.
"""
import json
import re
import sys

RESOURCE_TYPES = {
    "script": "script",
    "image": "image",
    "stylesheet": "stylesheet",
    "xmlhttprequest": "xmlhttprequest",
    "subdocument": "sub_frame",
    "media": "media",
    "font": "font",
    "websocket": "websocket",
    "other": "other",
    "object": "object",
    "ping": "ping",
    "webtransport": "webtransport",
}

UNSUPPORTED_OPTS = ("csp", "redirect", "rewrite", "removeparam", "replace", "header")


def convert(path):
    rules = []
    skipped = {"cosmetic": 0, "unsupported": 0, "regex": 0, "empty": 0}
    regex_budget = 400
    rid = 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("!") or line.startswith("["):
                skipped["empty"] += 1
                continue
            if "##" in line or "#@#" in line or "#?#" in line:
                skipped["cosmetic"] += 1
                continue

            is_exception = line.startswith("@@")
            if is_exception:
                line = line[2:]

            # Split pattern / options
            if "$" in line:
                pattern, optstr = line.split("$", 1)
                opts = [o.strip() for o in optstr.split(",") if o.strip()]
            else:
                pattern, opts = line, []
            if not pattern:
                skipped["empty"] += 1
                continue
            if any(o.split("=")[0].lstrip("~") in UNSUPPORTED_OPTS for o in opts):
                skipped["unsupported"] += 1
                continue

            cond = {}
            priority = 1
            rtypes = []
            for o in opts:
                neg = o.startswith("~")
                key = o.lstrip("~")
                if key in RESOURCE_TYPES and not neg:
                    rtypes.append(RESOURCE_TYPES[key])
                elif key == "third-party" and not neg:
                    cond["domainType"] = "thirdParty"
                elif key == "third-party" and neg:
                    cond["domainType"] = "firstParty"
                elif key == "important":
                    priority = 3
                elif key.startswith("domain="):
                    doms = key[len("domain="):].split("|")
                    pos = [d for d in doms if not d.startswith("~")]
                    negd = [d[1:] for d in doms if d.startswith("~")]
                    if pos:
                        cond["initiatorDomains"] = pos
                    if negd:
                        cond["excludedInitiatorDomains"] = negd
                # other options (match-case, sitekey, ...) are ignored
            if rtypes:
                cond["resourceTypes"] = sorted(set(rtypes))

            rid += 1
            rule = {"id": rid, "priority": priority, "condition": cond}
            if pattern.startswith("/") and pattern.endswith("/") and len(pattern) > 2:
                if regex_budget <= 0:
                    skipped["regex"] += 1
                    continue
                regex_budget -= 1
                cond["regexFilter"] = pattern[1:-1]
            else:
                cond["urlFilter"] = pattern
            rule["action"] = {"type": "allow"} if is_exception else {"type": "block"}
            if is_exception and priority == 1:
                rule["priority"] = 2
            rules.append(rule)
    return rules, skipped


def main():
    src, dst = sys.argv[1], sys.argv[2]
    rules, skipped = convert(src)
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(rules, fh, separators=(",", ":"), ensure_ascii=False)
    print(f"{src} -> {dst}: {len(rules)} rules, skipped={skipped}")


if __name__ == "__main__":
    main()
