#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo 'Uso: ensure-ghcr-sha-image.sh <owner/repo> <servicio> <sha> <GITHUB_OUTPUT>' >&2
  exit 64
}

[[ $# == 4 ]] || usage
repository="${1,,}" service="$2" sha="$3" output="$4"
[[ "$repository" =~ ^[a-z0-9_.-]+/[a-z0-9_.-]+$ ]] || usage
[[ "$service" =~ ^[a-z][a-z0-9-]{0,31}$ && "$sha" =~ ^[0-9a-f]{40}$ ]] || usage
[[ -n "$output" ]] || usage

image="ghcr.io/${repository}/${service}:${sha}"
source="https://github.com/${repository}"
inspect_error="$(mktemp)"
trap 'rm -f "$inspect_error"' EXIT

if docker manifest inspect "$image" >/dev/null 2>"$inspect_error"; then
  docker pull "$image" >/dev/null
  labels="$(docker image inspect "$image" --format '{{json .Config.Labels}}')"
  jq -e --arg source "$source" --arg revision "$sha" \
    '."org.opencontainers.image.source" == $source and ."org.opencontainers.image.revision" == $revision' \
    <<< "$labels" >/dev/null || {
      echo 'Existe una imagen para este SHA, pero su origen o revisión no se puede verificar; no se sobrescribe.' >&2
      exit 1
    }
  printf 'exists=true\nimage=%s\n' "$image" >> "$output"
  echo 'PASS: imagen GHCR existente verificada por paquete, origen y revisión; se reutilizará.'
  exit 0
fi

if ! grep -Eiq 'manifest unknown|no such manifest|not found|404' "$inspect_error"; then
  echo 'No se pudo comprobar con seguridad si la etiqueta GHCR existe.' >&2
  exit 1
fi
printf 'exists=false\nimage=%s\n' "$image" >> "$output"
echo 'PASS: no existe imagen para este SHA; se permite publicar una vez.'
