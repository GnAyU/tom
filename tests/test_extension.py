"""
Automated test suite for the Orochi AdBlock Chrome MV3 extension.

Run with:
    python3 -m unittest discover -s tests -v
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Repo root is one level above the tests/ directory.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def repo_path(*parts: str) -> str:
    """Return an absolute path relative to the repository root."""
    return os.path.join(ROOT, *parts)


def load_json(rel_path: str):
    """Load and return a JSON file from the repo root."""
    with open(repo_path(rel_path), encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# 1.  manifest.json
# ---------------------------------------------------------------------------

class TestManifest(unittest.TestCase):
    """Section 1 – manifest.json structure and file references."""

    @classmethod
    def setUpClass(cls):
        with open(repo_path("manifest.json"), encoding="utf-8") as fh:
            cls.raw = fh.read()
        cls.manifest = json.loads(cls.raw)

    # 1-a  The file is valid JSON (covered implicitly by setUpClass, but
    #      we make it an explicit test with a clear failure message).
    def test_01_parses_as_valid_json(self):
        """manifest.json must be parseable as JSON."""
        try:
            json.loads(self.raw)
        except json.JSONDecodeError as exc:
            self.fail(f"manifest.json is not valid JSON: {exc}")

    # 1-b  manifest_version == 3
    def test_02_manifest_version_is_3(self):
        self.assertEqual(
            self.manifest.get("manifest_version"),
            3,
            "manifest_version must be 3 (Manifest V3)",
        )

    # 1-c  declarative_net_request.rule_resources lists exactly three rulesets
    def test_03_rule_resources_has_exactly_three_entries(self):
        resources = (
            self.manifest
            .get("declarative_net_request", {})
            .get("rule_resources", [])
        )
        self.assertEqual(
            len(resources),
            3,
            f"Expected exactly 3 rule_resources, found {len(resources)}",
        )

    # 1-d  The three rulesets reference the correct files
    def test_04_rule_resource_paths_are_correct(self):
        resources = (
            self.manifest
            .get("declarative_net_request", {})
            .get("rule_resources", [])
        )
        expected_paths = {
            "rules/easylist.json",
            "rules/easylistchina.json",
            "rules/easyprivacy.json",
        }
        actual_paths = {r.get("path") for r in resources}
        self.assertEqual(
            actual_paths,
            expected_paths,
            f"rule_resource paths mismatch.\n  expected: {expected_paths}\n  actual:   {actual_paths}",
        )

    # 1-e  Each referenced path actually exists on disk
    def test_05_rule_resource_files_exist_on_disk(self):
        resources = (
            self.manifest
            .get("declarative_net_request", {})
            .get("rule_resources", [])
        )
        for entry in resources:
            path = entry.get("path", "")
            full = repo_path(path)
            self.assertTrue(
                os.path.isfile(full),
                f"Rule resource path does not exist on disk: {path!r}  (resolved: {full!r})",
            )

    # 1-f  background.service_worker file exists
    def test_06_service_worker_file_exists(self):
        sw_rel = self.manifest.get("background", {}).get("service_worker", "")
        self.assertTrue(
            sw_rel,
            "background.service_worker is missing or empty in manifest.json",
        )
        full = repo_path(sw_rel)
        self.assertTrue(
            os.path.isfile(full),
            f"service_worker file not found on disk: {sw_rel!r}  (resolved: {full!r})",
        )

    # 1-g  action.default_popup file exists
    def test_07_default_popup_file_exists(self):
        popup_rel = self.manifest.get("action", {}).get("default_popup", "")
        self.assertTrue(
            popup_rel,
            "action.default_popup is missing or empty in manifest.json",
        )
        full = repo_path(popup_rel)
        self.assertTrue(
            os.path.isfile(full),
            f"default_popup file not found on disk: {popup_rel!r}  (resolved: {full!r})",
        )


# ---------------------------------------------------------------------------
# 2.  rules/*.json
# ---------------------------------------------------------------------------

VALID_ACTION_TYPES = frozenset({"block", "allow", "redirect", "upgradeScheme"})
RULE_FILES = [
    "rules/easylist.json",
    "rules/easylistchina.json",
    "rules/easyprivacy.json",
]


def _make_rules_tests(rel_path: str):
    """
    Return a TestCase class dynamically constructed for one rules file.

    We use a factory so every ruleset gets its own named test class, which
    makes the -v output clearly identify which file a failure came from.
    """
    # Load once at class-creation time; avoids re-loading inside every test.
    full_path = repo_path(rel_path)
    file_tag = os.path.splitext(os.path.basename(rel_path))[0]  # e.g. "easylist"

    class _RulesFileTests(unittest.TestCase):
        _rel_path = rel_path
        _full_path = full_path
        _data = None  # set in setUpClass

        @classmethod
        def setUpClass(cls):
            with open(cls._full_path, encoding="utf-8") as fh:
                cls._data = json.load(fh)

        # 2-a  Parses as a JSON array
        def test_a_parses_as_json_array(self):
            self.assertIsInstance(
                self._data,
                list,
                f"{self._rel_path}: top-level JSON value must be an array",
            )

        # 2-b  Contains more than 1 000 rules
        def test_b_more_than_1000_rules(self):
            count = len(self._data)
            self.assertGreater(
                count,
                1000,
                f"{self._rel_path}: expected > 1000 rules, found {count}",
            )

        # 2-c  Rule ids are unique within the file
        def test_c_rule_ids_are_unique(self):
            ids = [rule.get("id") for rule in self._data]
            seen = set()
            duplicates = set()
            for rid in ids:
                if rid in seen:
                    duplicates.add(rid)
                seen.add(rid)
            self.assertFalse(
                duplicates,
                f"{self._rel_path}: duplicate rule ids found: {sorted(duplicates)[:20]}",
            )

        # 2-d  Every rule's action.type is one of the four permitted values
        def test_d_action_types_are_valid(self):
            bad = []
            for rule in self._data:
                atype = rule.get("action", {}).get("type")
                if atype not in VALID_ACTION_TYPES:
                    bad.append((rule.get("id"), atype))
            self.assertFalse(
                bad,
                f"{self._rel_path}: rules with invalid action.type "
                f"(showing first 10): {bad[:10]}",
            )

        # 2-e  Every rule has a condition with urlFilter OR regexFilter
        def test_e_condition_has_url_or_regex_filter(self):
            bad = []
            for rule in self._data:
                cond = rule.get("condition", {})
                if "urlFilter" not in cond and "regexFilter" not in cond:
                    bad.append(rule.get("id"))
            self.assertFalse(
                bad,
                f"{self._rel_path}: rules missing urlFilter/regexFilter "
                f"(showing first 10 ids): {bad[:10]}",
            )

    # Give the class a descriptive name so unittest -v output is clear.
    _RulesFileTests.__name__ = f"TestRules_{file_tag}"
    _RulesFileTests.__qualname__ = f"TestRules_{file_tag}"
    return _RulesFileTests


# Register a test class per rules file in the module's global namespace so
# the unittest test-discovery machinery can find them.
for _rp in RULE_FILES:
    _cls = _make_rules_tests(_rp)
    globals()[_cls.__name__] = _cls


# ---------------------------------------------------------------------------
# 3.  tools/convert.py  – end-to-end
# ---------------------------------------------------------------------------

FIXTURE_FILTER_LIST = """\
! Orochi AdBlock test fixture — do not use in production
[Adblock Plus 2.0]
||example-ads.com^
@@||example-ads.com^$document
##.ad-banner
||another-tracker.net^
"""


class TestConvertEndToEnd(unittest.TestCase):
    """Section 3 – end-to-end test for tools/convert.py."""

    @classmethod
    def setUpClass(cls):
        """Write the fixture, run the converter, load the output."""
        cls._tmpdir = tempfile.mkdtemp(prefix="orochi_test_")
        cls._input_path = os.path.join(cls._tmpdir, "fixture.txt")
        cls._output_path = os.path.join(cls._tmpdir, "fixture.json")
        cls._converter = repo_path("tools", "convert.py")

        # Write the fixture filter list.
        with open(cls._input_path, "w", encoding="utf-8") as fh:
            fh.write(FIXTURE_FILTER_LIST)

        # Run the converter as a subprocess (tests it as a CLI tool).
        result = subprocess.run(
            [sys.executable, cls._converter, cls._input_path, cls._output_path],
            capture_output=True,
            text=True,
        )
        cls._proc_stdout = result.stdout
        cls._proc_stderr = result.stderr
        cls._proc_returncode = result.returncode

        # Load the output if the converter succeeded.
        if result.returncode == 0 and os.path.isfile(cls._output_path):
            with open(cls._output_path, encoding="utf-8") as fh:
                cls._rules = json.load(fh)
        else:
            cls._rules = None

    @classmethod
    def tearDownClass(cls):
        """Clean up temp files."""
        import shutil
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    # --- subprocess basics ---------------------------------------------------

    def test_01_converter_exits_zero(self):
        """convert.py must exit with return-code 0."""
        self.assertEqual(
            self._proc_returncode,
            0,
            f"convert.py exited with code {self._proc_returncode}.\n"
            f"stdout: {self._proc_stdout}\nstderr: {self._proc_stderr}",
        )

    def test_02_output_file_is_created(self):
        """convert.py must create the output JSON file."""
        self.assertTrue(
            os.path.isfile(self._output_path),
            "convert.py did not create the output file",
        )

    def test_03_output_is_a_json_array(self):
        """Output file must be a JSON array."""
        self.assertIsNotNone(self._rules, "Output JSON could not be loaded")
        self.assertIsInstance(self._rules, list, "Output JSON must be an array")

    # --- blocking rule -------------------------------------------------------

    def test_04_block_rule_present(self):
        """A 'block' rule for ||example-ads.com^ must appear in the output."""
        self.assertIsNotNone(self._rules, "Output JSON could not be loaded")
        matches = [
            r for r in self._rules
            if r.get("condition", {}).get("urlFilter") == "||example-ads.com^"
            and r.get("action", {}).get("type") == "block"
        ]
        self.assertTrue(
            matches,
            "No 'block' rule with urlFilter '||example-ads.com^' found in output.\n"
            f"Rules produced: {self._rules}",
        )

    def test_05_block_rule_has_correct_action_type(self):
        """The blocking rule's action.type must be exactly 'block'."""
        self.assertIsNotNone(self._rules, "Output JSON could not be loaded")
        block_rules = [
            r for r in self._rules
            if r.get("condition", {}).get("urlFilter") == "||example-ads.com^"
        ]
        # At least one must be block (the exception may also match, so we
        # look specifically for the block entry).
        block_action = [r for r in block_rules if r.get("action", {}).get("type") == "block"]
        self.assertTrue(
            block_action,
            f"Expected a rule with action.type='block' for ||example-ads.com^. "
            f"Found: {block_rules}",
        )

    # --- exception (allow) rule ----------------------------------------------

    def test_06_allow_rule_present(self):
        """An 'allow' rule for @@||example-ads.com^$document must appear in the output."""
        self.assertIsNotNone(self._rules, "Output JSON could not be loaded")
        matches = [
            r for r in self._rules
            if r.get("condition", {}).get("urlFilter") == "||example-ads.com^"
            and r.get("action", {}).get("type") == "allow"
        ]
        self.assertTrue(
            matches,
            "No 'allow' rule with urlFilter '||example-ads.com^' found in output.\n"
            f"Rules produced: {self._rules}",
        )

    def test_07_allow_rule_has_correct_action_type(self):
        """The exception rule's action.type must be exactly 'allow'."""
        self.assertIsNotNone(self._rules, "Output JSON could not be loaded")
        allow_rules = [
            r for r in self._rules
            if r.get("condition", {}).get("urlFilter") == "||example-ads.com^"
            and r.get("action", {}).get("type") == "allow"
        ]
        self.assertTrue(
            allow_rules,
            "Expected action.type='allow' for the exception rule. "
            f"Matching rules: {allow_rules}",
        )

    # --- cosmetic rule must be skipped ---------------------------------------

    def test_08_cosmetic_rule_not_converted(self):
        """
        The cosmetic line '##.ad-banner' must not produce any rule.
        Cosmetic rules are handled by cosmetic.js, not declarativeNetRequest.
        """
        self.assertIsNotNone(self._rules, "Output JSON could not be loaded")

        # The cosmetic rule ##.ad-banner would appear as a urlFilter containing
        # ".ad-banner" with "##" somewhere, or the entire raw line. We check
        # that no rule's urlFilter / regexFilter contains the cosmetic marker.
        bad_rules = []
        for r in self._rules:
            cond = r.get("condition", {})
            for key in ("urlFilter", "regexFilter"):
                val = cond.get(key, "")
                if "##" in val or ".ad-banner" in val:
                    bad_rules.append(r)

        self.assertFalse(
            bad_rules,
            f"Cosmetic rule was incorrectly converted to network rule(s): {bad_rules}",
        )

    def test_09_total_network_rules_count(self):
        """
        The fixture has exactly 2 network rules (||example-ads.com^ and
        ||another-tracker.net^) plus 1 exception (@@||example-ads.com^$document).
        The converter must produce exactly 3 rules (cosmetic + comment skipped).
        """
        self.assertIsNotNone(self._rules, "Output JSON could not be loaded")
        self.assertEqual(
            len(self._rules),
            3,
            f"Expected exactly 3 rules from the fixture, got {len(self._rules)}.\n"
            f"Rules: {self._rules}",
        )

    def test_10_rule_ids_are_unique_in_output(self):
        """Rule ids in the converter output must be unique."""
        self.assertIsNotNone(self._rules, "Output JSON could not be loaded")
        ids = [r.get("id") for r in self._rules]
        self.assertEqual(
            len(ids),
            len(set(ids)),
            f"Duplicate ids in converter output: {ids}",
        )


# ---------------------------------------------------------------------------
# Entry point (also works with `python3 tests/test_extension.py -v`)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    unittest.main(verbosity=2)
