param(
    [string]$Organization = 'Taller-SW-Web',
    [string]$Repository = 'Taller-SW-Web/G6-Productos-Ofertas-backend',
    [int]$RunnerGroupId = 3,
    [ValidateSet('brazil-isolated','chile-shared')][string]$Destination = 'brazil-isolated'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'deployment-targets.ps1')
$target = Resolve-H5DeploymentTarget -Destination $Destination
if ($RunnerGroupId -ne $target.RunnerGroupId) { throw 'FAIL: runner group ID does not match the destination configuration.' }
$workflow = "$Repository/.github/workflows/cd-services-azure.yml@refs/heads/master"

function Invoke-GhJson {
    param([Parameter(Mandatory)][string]$Endpoint)
    $output = & gh api $Endpoint 2>$null
    if ($LASTEXITCODE -ne 0) { throw "GitHub API read failed: $Endpoint" }
    return (($output -join "`n") | ConvertFrom-Json)
}

$group = Invoke-GhJson "orgs/$Organization/actions/runner-groups/$RunnerGroupId"
if ($group.restricted_to_workflows -ne $true -or @($group.selected_workflows).Count -ne 1 -or $group.selected_workflows[0] -cne $workflow) {
    throw 'FAIL: runner group must allow only the CD workflow at refs/heads/master.'
}
$selectedRepos = Invoke-GhJson "orgs/$Organization/actions/runner-groups/$RunnerGroupId/repositories"
if (@($selectedRepos.repositories).Count -ne 1 -or $selectedRepos.repositories[0].full_name -cne $Repository) {
    throw 'FAIL: runner group must select only the G6 backend repository.'
}
$environment = Invoke-GhJson "repos/$Repository/environments/$($target.GitHubEnvironment)"
$hasReviewer = @($environment.protection_rules | Where-Object { $_.type -eq 'required_reviewers' -and $_.prevent_self_review -eq $true -and @($_.reviewers).Count -gt 0 }).Count -gt 0
$masterOnly = $environment.deployment_branch_policy.custom_branch_policies -eq $true -and $environment.deployment_branch_policy.protected_branches -eq $false
if ($environment.can_admins_bypass -ne $false -or -not $hasReviewer -or -not $masterOnly) {
    throw "FAIL: $($target.GitHubEnvironment) reviewers, self-approval prevention, master policy, or admin bypass protection is invalid."
}
$branchPolicies = Invoke-GhJson "repos/$Repository/environments/$($target.GitHubEnvironment)/deployment-branch-policies?per_page=100"
if ($branchPolicies.total_count -ne 1 -or @($branchPolicies.branch_policies | Where-Object { $_.type -eq 'branch' -and $_.name -ceq 'master' }).Count -ne 1) {
    throw "FAIL: $($target.GitHubEnvironment) does not allow exactly branch master."
}

$root = (& git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not locate repository root.' }
$workflowPath = Join-Path $root '.github/workflows/cd-services-azure.yml'
$source = Get-Content -LiteralPath $workflowPath -Raw
if ($source -match '(?m)^\s+pull_request(?:_target)?:') { throw 'FAIL: CD workflow can trigger directly from an untrusted pull request.' }
if ($source -notmatch "(?m)^'on':\s*\r?\n\s+workflow_dispatch:") { throw 'FAIL: CD workflow is not restricted to workflow_dispatch.' }

Write-Output "PASS runner authorization: repository/workflow allowlists and $($target.GitHubEnvironment) human protections verified; smokeLabel=$($target.SmokeLabel); allows_public_repositories=$($group.allows_public_repositories)."
