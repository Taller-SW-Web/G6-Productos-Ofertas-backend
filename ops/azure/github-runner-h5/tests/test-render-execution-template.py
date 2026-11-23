#!/usr/bin/env python3
"""Focused tests for the ACA execution-template YAML renderer."""

import json
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "render-execution-template.py"
BASE = {
    "containers": [
        {
            "name": "runner",
            "image": "ghcr.io/actions/actions-runner@sha256:" + "a" * 64,
            "command": ["/bin/bash", "-c"],
            "args": ['exec /home/runner/run.sh --jitconfig "$jit_config"'],
            "resources": {"cpu": 0.5, "memory": "1Gi"},
        }
    ],
    "initContainers": None,
    "volumes": None,
}


def invoke(*args: str, template: dict | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RENDERER), *args],
        input=json.dumps(BASE if template is None else template),
        text=True,
        capture_output=True,
        check=False,
    )


normal = invoke("--set-env", "H5_PREFLIGHT_REF=refs/heads/work")
assert normal.returncode == 0, normal.stderr
normal_template = yaml.safe_load(normal.stdout)
assert normal_template["containers"][0]["env"] == [
    {"name": "H5_PREFLIGHT_REF", "value": "refs/heads/work"}
]
assert normal_template["containers"][0]["image"] == BASE["containers"][0]["image"]

secret = invoke("--set-secret", "H5_RUNNER_JIT_CONFIG=h5jit")
assert secret.returncode == 0, secret.stderr
secret_template = yaml.safe_load(secret.stdout)
assert secret_template["containers"][0]["env"] == [
    {"name": "H5_RUNNER_JIT_CONFIG", "secretRef": "h5jit"}
]
assert "encoded_jit_config" not in secret.stdout

already_configured = json.loads(json.dumps(BASE))
already_configured["containers"][0]["env"] = [
    {"name": "H5_RUNNER_JIT_CONFIG", "value": "existing"}
]
duplicate = invoke("--set-env", "H5_RUNNER_JIT_CONFIG=plain", template=already_configured)
assert duplicate.returncode == 2
assert invoke("--set-env", "BAD").returncode == 2
print("PASS: ACA execution template YAML renders and preserves runner image/command safely")
