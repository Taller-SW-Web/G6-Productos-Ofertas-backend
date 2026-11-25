"""Static reconciliation checks for Castilla's APIM harness; no Azure calls."""
import json
import os
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
APIM = ROOT / "ops" / "azure" / "apim"
DOCS = Path(os.environ.get("H5_DOCS_ROOT", ROOT.parent / "docs"))


def table_rows(text: str) -> dict[str, str]:
    return {f"APIM-{case_id}": label.strip() for case_id, label in re.findall(r"\|\s*(?:APIM-)?(T\d{2})\s*\|\s*([^|]+)", text)}


class CastillaApimPreflight(unittest.TestCase):
    def test_apim_provenance_fields_are_full_shas_and_g5_default_is_false(self) -> None:
        manifest = json.loads((APIM / "openapi" / "operation-security.json").read_text(encoding="utf-8"))
        self.assertRegex(manifest["docsSha"], r"^[0-9a-f]{40}$")
        self.assertRegex(manifest["gatewaySha"], r"^[0-9a-f]{40}$")
        self.assertIs(manifest["g5EnabledByDefault"], False)

    def test_burst_and_quota_are_present_as_distinct_controls(self) -> None:
        policy = (APIM / "policies" / "api.xml").read_text(encoding="utf-8")
        self.assertRegex(policy, r"<rate-limit-by-key\b")
        self.assertRegex(policy, r"<quota-by-key\b")
        self.assertIn("Retry-After", policy)

    @unittest.skipUnless((DOCS / "hitos" / "h5" / "04_API_MANAGEMENT.md").is_file(), "Docs checkout not available; reconciliation requires a Docs worktree")
    def test_docs_apim_t_labels_are_not_collapsed_into_backend_readme_labels(self) -> None:
        docs_text = (DOCS / "hitos" / "h5" / "04_API_MANAGEMENT.md").read_text(encoding="utf-8")
        backend_text = (APIM / "README.md").read_text(encoding="utf-8")
        docs_rows = table_rows(docs_text)
        backend_rows = table_rows(backend_text)
        self.assertIn("APIM-T05", docs_rows)
        self.assertIn("APIM-T05", backend_rows)
        self.assertNotEqual(docs_rows["APIM-T05"], backend_rows["APIM-T05"])
        self.assertIn("APIM-T05", {key for key in docs_rows if docs_rows.get(key) != backend_rows.get(key)})


if __name__ == "__main__":
    unittest.main()
