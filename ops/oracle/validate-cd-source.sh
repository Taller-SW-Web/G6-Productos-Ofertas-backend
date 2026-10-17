#!/usr/bin/env bash
set -Eeuo pipefail

readonly repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
readonly event="${TRIGGER_EVENT:?TRIGGER_EVENT is required}"
readonly output_file="${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

case "$event" in
  workflow_run)
    [[ "${CI_NAME:-}" == CI && "${CI_PATH:-}" == .github/workflows/ci.yml ]] || {
      echo 'El workflow origen no es CI.' >&2
      exit 1
    }
    [[ "${CI_EVENT:-}" == push && "${CI_BRANCH:-}" == master && "${CI_CONCLUSION:-}" == success ]] || {
      echo 'Solo se acepta CI exitosa de push a master.' >&2
      exit 1
    }
    [[ "${CI_HEAD_REPOSITORY,,}" == "${repository,,}" ]] || {
      echo 'Se rechazan PRs y forks.' >&2
      exit 1
    }
    [[ "${CI_SHA:-}" =~ ^[0-9a-f]{40}$ && "${CI_RUN_ID:-}" =~ ^[0-9]+$ ]] || {
      echo 'SHA o ID de ejecución CI inválido.' >&2
      exit 1
    }
    run_data="$(gh api "repos/${repository}/actions/runs/${CI_RUN_ID}" --jq '[.name,.path,.event,.head_branch,.head_sha,.conclusion,.head_repository.full_name] | @tsv')"
    expected_data="$(printf 'CI\t.github/workflows/ci.yml\tpush\tmaster\t%s\tsuccess\t%s' "$CI_SHA" "$repository")"
    [[ "${run_data,,}" == "${expected_data,,}" ]] || {
      echo 'La ejecución CI consultada no coincide con el evento recibido.' >&2
      exit 1
    }
    sha="$CI_SHA"
    ;;
  workflow_dispatch)
    [[ "${GITHUB_REF:-}" == refs/heads/master ]] || { echo 'El dispatch manual solo se acepta en master.' >&2; exit 1; }
    sha="${GITHUB_SHA:-}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'SHA inválido.' >&2; exit 1; }
    ci_success="$(gh run list --repo "$repository" --workflow ci.yml --branch master --commit "$sha" --json conclusion,event,headBranch --jq 'any(.[]; .conclusion == "success" and .event == "push" and .headBranch == "master")')"
    [[ "$ci_success" == true ]] || { echo "No successful CI push run was found for master commit $sha." >&2; exit 1; }
    ;;
  *)
    echo 'Evento no permitido.' >&2
    exit 1
    ;;
esac

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'SHA inválido.' >&2; exit 1; }
current="$(gh api "repos/${repository}/commits/master" --jq .sha)"
if [[ "$sha" != "$current" ]]; then
  echo "Skipping obsolete commit $sha; master is now $current."
  echo 'sha=' >> "$output_file"
  exit 0
fi

echo "sha=$sha" >> "$output_file"
echo "repository=${repository,,}" >> "$output_file"
