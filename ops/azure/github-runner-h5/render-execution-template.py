#!/usr/bin/env python3
"""Render a validated ACA Job execution-template override as Azure CLI YAML."""

import argparse
import json
import sys

import yaml


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--set-env", action="append", default=[])
    parser.add_argument("--set-secret", action="append", default=[])
    parser.add_argument("--replace-args", action="store_true")
    parser.add_argument("--set-arg", action="append", default=[])
    args = parser.parse_args()

    try:
        template = json.load(sys.stdin)
        containers = template.get("containers")
        if not isinstance(containers, list) or len(containers) != 1:
            raise ValueError("unexpected container list")
        container = containers[0]
        if container.get("name") != "runner":
            raise ValueError("unexpected container name")
        env = container.get("env") or []
        if not isinstance(env, list):
            raise ValueError("unexpected environment list")
        names = {item.get("name") for item in env if isinstance(item, dict)}
        for item in args.set_env:
            name, separator, value = item.partition("=")
            if not separator or not name or name in names:
                raise ValueError("invalid or duplicate environment variable")
            env.append({"name": name, "value": value})
            names.add(name)
        for item in args.set_secret:
            name, separator, secret_name = item.partition("=")
            if not separator or not name or not secret_name or name in names:
                raise ValueError("invalid or duplicate secret reference")
            env.append({"name": name, "secretRef": secret_name})
            names.add(name)
        if args.replace_args:
            if not args.set_arg:
                raise ValueError("replacement arguments are required")
            container["args"] = args.set_arg
        if env:
            container["env"] = env
        sys.stdout.write(yaml.safe_dump(template, sort_keys=False))
    except Exception:
        print("Invalid Container Apps execution template.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
