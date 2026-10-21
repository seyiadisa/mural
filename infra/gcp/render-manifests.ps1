param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$ImageTag,
  [Parameter(Mandatory = $true)][string]$GoogleClientId,
  [Parameter(Mandatory = $true)][string]$OwnerEmail,
  [string]$WebOrigin
)

$ErrorActionPreference = 'Stop'

if ($ProjectId -notmatch '^[a-z][a-z0-9-]{4,28}[a-z0-9]$') { throw 'ProjectId is not a valid Google Cloud project ID.' }
if ($Region -notmatch '^[a-z]+-[a-z0-9]+$') { throw 'Region must look like us-central1.' }
if ($ImageTag -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$') { throw 'ImageTag contains unsupported characters.' }
if ($GoogleClientId -notmatch '^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$') { throw 'GoogleClientId is not a Google OAuth client ID.' }
if ($OwnerEmail -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw 'OwnerEmail is not a valid email address.' }

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw 'Install the Google Cloud CLI and run gcloud auth login first.' }
$projectNumber = (& gcloud projects describe $ProjectId --format='value(projectNumber)' 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $projectNumber -notmatch '^\d+$') { throw 'Could not read the Google Cloud project number. Check project access and gcloud auth.' }

$isPublic = $false
if ($WebOrigin) {
  $originUri = $null
  if (-not [Uri]::TryCreate($WebOrigin, [UriKind]::Absolute, [ref]$originUri) -or
      $originUri.Scheme -ne 'https' -or $originUri.AbsolutePath -ne '/' -or $originUri.Query -or
      $originUri.Fragment -or $originUri.UserInfo) {
    throw 'WebOrigin must be an HTTPS origin only, such as https://mural-abc-uc.a.run.app.'
  }
  $WebOrigin = $originUri.GetLeftPart([UriPartial]::Authority)
  $isPublic = $true
} else {
  $WebOrigin = 'https://mural.invalid'
}

$replacement = @{
  '__PROJECT_ID__' = $ProjectId
  '__PROJECT_NUMBER__' = $projectNumber
  '__REGION__' = $Region
  '__TAG__' = $ImageTag
  '__GOOGLE_CLIENT_ID__' = $GoogleClientId
  '__OWNER_EMAIL__' = $OwnerEmail
  '__WEB_ORIGIN__' = $WebOrigin
  '__PUBLIC__' = $isPublic.ToString().ToLowerInvariant()
}

$outputDirectory = Join-Path $env:TEMP "mural-gcp-$ProjectId"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

foreach ($fileName in @('service.yaml', 'job.yaml')) {
  $templateName = if ($fileName -eq 'service.yaml') { 'service.yaml.template' } else { 'job.yaml.template' }
  $templatePath = Join-Path $PSScriptRoot $templateName
  $content = Get-Content -LiteralPath $templatePath -Raw
  foreach ($key in $replacement.Keys) { $content = $content.Replace($key, $replacement[$key]) }
  if ($content -match '__[A-Z0-9_]+__') { throw "Unresolved placeholder remains in $templateName." }
  Set-Content -LiteralPath (Join-Path $outputDirectory $fileName) -Value $content -Encoding utf8
}

Write-Output "Rendered Cloud Run manifests to $outputDirectory"
if (-not $isPublic) {
  Write-Output 'Bootstrap mode: the service stays private and uses a placeholder origin. After the first deploy, get its URL, authorize that origin in Google OAuth, then render again with -WebOrigin <service-url>.'
} else {
  Write-Output 'Public mode: Cloud Run allows requests through to the app, which still requires the configured owner Google sign-in.'
}
