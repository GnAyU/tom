"""v1.0 regression tests; run via the existing unittest discovery command.

JavaScript runs in Node's built-in vm with a minimal Chrome API mock.
No npm packages or extension runtime dependencies are required.
"""
import json
import os
import subprocess
import unittest
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TestV1Manifest(unittest.TestCase):
    def test_options_version_and_permissions(self):
        with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as fh:
            manifest = json.load(fh)
        self.assertEqual(manifest["version"], "1.0.0")
        self.assertEqual(set(manifest["permissions"]), {
            "declarativeNetRequest", "declarativeNetRequestFeedback", "storage", "tabs",
        })
        self.assertEqual(manifest["options_ui"], {"page": "options.html", "open_in_tab": True})
        self.assertEqual(manifest["content_scripts"][0]["js"], ["rules.js", "cosmetic.js"])

    def test_local_scripts_exist_and_no_inline_handlers(self):
        class Scripts(HTMLParser):
            def handle_starttag(self, tag, attrs):
                attrs = dict(attrs)
                self_test.assertFalse(any(key.startswith("on") for key in attrs))
                if tag == "script":
                    self_test.assertIn("src", attrs)
                    self_test.assertTrue(os.path.isfile(os.path.join(ROOT, attrs["src"])))

        self_test = self
        for name in ("popup.html", "options.html"):
            with open(os.path.join(ROOT, name), encoding="utf-8") as fh:
                Scripts().feed(fh.read())


class TestV1Runtime(unittest.TestCase):
    """Test the actual shared, service-worker, content and popup scripts."""


def make_runtime_test(name):
    def test(self):
        result = subprocess.run(
            ["node", os.path.join(ROOT, "tests", "runtime_checks.js"), name],
            capture_output=True, text=True, cwd=ROOT, timeout=30,
        )
        self.assertEqual(result.returncode, 0,
                         f"stdout: {result.stdout}\nstderr: {result.stderr}")
        self.assertIn(f"PASS {name}", result.stdout)
    return test


for _name in (
    "block_rules", "invalid_domains", "whitelist_remove_pure", "selectors_pure",
    "startup_sync", "whitelist_remove_message", "concurrent_mutations",
    "domain_add_remove", "selectors_storage", "global_and_rulesets",
    "rollback_and_recovery", "counter_compatibility", "cosmetic_live", "popup_options",
):
    setattr(TestV1Runtime, "test_" + _name, make_runtime_test(_name))


if __name__ == "__main__":
    unittest.main(verbosity=2)
