<#
.SYNOPSIS
    Local web server for the Config Knowledge Map app.

.DESCRIPTION
    Serves the static frontend (public/) and a small JSON API:
      GET  /api/list-prefs?dir=<path>        -> list .pref files in a folder
      GET  /api/read-pref?path=<file>         -> read contents of a .pref file
      GET  /api/annotations                   -> read annotations.json
      POST /api/annotations  (JSON body)      -> save annotations.json
      GET  /api/groups                        -> read groups.json
      POST /api/groups       (JSON body)      -> save groups.json

    Run with:  pwsh ./server.ps1
    Then open: http://localhost:8080

.PARAMETER Port
    TCP port to listen on. Default 8080.

.PARAMETER PrefsDir
    Default folder to scan for .pref files. Default ./prefs next to this script.
#>
param(
    [int]$Port = 8080,
    [string]$PrefsDir = (Join-Path $PSScriptRoot "prefs")
)

$ErrorActionPreference = "Stop"

$PublicDir = Join-Path $PSScriptRoot "public"
$AnnotationsFile = Join-Path $PSScriptRoot "annotations.json"
$GroupsFile = Join-Path $PSScriptRoot "groups.json"

if (-not (Test-Path $PrefsDir)) {
    New-Item -ItemType Directory -Path $PrefsDir | Out-Null
}
if (-not (Test-Path $AnnotationsFile)) {
    '{}' | Set-Content -Path $AnnotationsFile -Encoding UTF8
}
if (-not (Test-Path $GroupsFile)) {
    '{}' | Set-Content -Path $GroupsFile -Encoding UTF8
}

$MimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
}

function Get-MimeType($path) {
    $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
    if ($MimeTypes.ContainsKey($ext)) { return $MimeTypes[$ext] }
    return "application/octet-stream"
}

function Write-JsonResponse($response, $obj, [int]$statusCode = 200) {
    # Depth > 2 makes Windows PowerShell 5.1's ConvertTo-Json recurse into
    # string characters, which explodes exponentially on file-content-sized
    # strings (e.g. /api/read-pref) and can hang the single-threaded server.
    $json = $obj | ConvertTo-Json -Depth 2 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $response.StatusCode = $statusCode
    $response.ContentType = "application/json; charset=utf-8"
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.OutputStream.Close()
}

function Write-TextResponse($response, [string]$text, [string]$contentType = "text/plain; charset=utf-8", [int]$statusCode = 200) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $response.StatusCode = $statusCode
    $response.ContentType = $contentType
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.OutputStream.Close()
}

function Get-QueryParam($request, [string]$name) {
    $query = $request.Url.Query
    if ([string]::IsNullOrEmpty($query)) { return $null }
    $parsed = [System.Web.HttpUtility]::ParseQueryString($query)
    return $parsed[$name]
}

# Prevent path traversal outside an allowed root when reading files by name.
function Resolve-SafePath([string]$root, [string]$relativeOrAbsolute) {
    if ([string]::IsNullOrWhiteSpace($relativeOrAbsolute)) { return $null }
    $candidate = $relativeOrAbsolute
    if (-not [System.IO.Path]::IsPathRooted($candidate)) {
        $candidate = Join-Path $root $candidate
    }
    $full = [System.IO.Path]::GetFullPath($candidate)
    return $full
}

Add-Type -AssemblyName System.Web

$listener = [System.Net.HttpListener]::new()
# "localhost" (unlike a wildcard "+" or "*" prefix) is exempt from Windows'
# URL ACL reservation, so this binds without requiring an elevated process.
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Error "Failed to start listener on $prefix. $_"
    exit 1
}

Write-Host "Config Knowledge Map server running at $prefix"
Write-Host "Serving static files from: $PublicDir"
Write-Host "Default prefs folder:      $PrefsDir"
Write-Host "Annotations file:          $AnnotationsFile"
Write-Host "Groups file:               $GroupsFile"
Write-Host "Press Ctrl+C to stop."

# A plain blocking GetContext() call has no return point until a request
# arrives, so PowerShell's Ctrl+C break handling (which only interrupts
# between statements) never gets a chance to run and Ctrl+C appears to do
# nothing. Polling the async accept with a short wait instead gives the
# engine a safe point every 250ms, so Ctrl+C is picked up quickly and still
# unwinds through the try/finally below for a clean shutdown.
try {
    while ($listener.IsListening) {
        $asyncResult = $listener.BeginGetContext($null, $null)
        while (-not $asyncResult.AsyncWaitHandle.WaitOne(250)) {
            # Loop back around so a pending Ctrl+C can interrupt here.
        }
        $context = $listener.EndGetContext($asyncResult)
        $request = $context.Request
        $response = $context.Response

        try {
            $path = $request.Url.AbsolutePath

            if ($request.HttpMethod -eq "GET" -and $path -eq "/api/list-prefs") {
                $dir = Get-QueryParam $request "dir"
                if ([string]::IsNullOrWhiteSpace($dir)) { $dir = $PrefsDir }
                $full = Resolve-SafePath $PSScriptRoot $dir
                if (-not (Test-Path $full -PathType Container)) {
                    Write-JsonResponse $response @{ error = "Directory not found: $full" } 404
                } else {
                    $files = Get-ChildItem -Path $full -Filter "*.pref" -File -Recurse -ErrorAction SilentlyContinue |
                        ForEach-Object {
                            [PSCustomObject]@{
                                name = $_.Name
                                path = $_.FullName
                                sizeBytes = $_.Length
                                modified = $_.LastWriteTimeUtc.ToString("o")
                            }
                        }
                    Write-JsonResponse $response @{ dir = $full; files = @($files) }
                }
            }
            elseif ($request.HttpMethod -eq "GET" -and $path -eq "/api/read-pref") {
                $filePath = Get-QueryParam $request "path"
                if ([string]::IsNullOrWhiteSpace($filePath)) {
                    Write-JsonResponse $response @{ error = "Missing 'path' query parameter" } 400
                } else {
                    $full = Resolve-SafePath $PSScriptRoot $filePath
                    if (-not (Test-Path $full -PathType Leaf)) {
                        Write-JsonResponse $response @{ error = "File not found: $full" } 404
                    } else {
                        # File.ReadAllText avoids Get-Content's ETS decoration
                        # (PSPath, PSDrive, ...), which ConvertTo-Json would
                        # otherwise serialize instead of a plain string.
                        $content = [System.IO.File]::ReadAllText($full)
                        Write-JsonResponse $response @{ path = $full; content = $content }
                    }
                }
            }
            elseif ($request.HttpMethod -eq "GET" -and $path -eq "/api/annotations") {
                $content = Get-Content -Path $AnnotationsFile -Raw -Encoding UTF8
                Write-TextResponse $response $content "application/json; charset=utf-8"
            }
            elseif ($request.HttpMethod -eq "POST" -and $path -eq "/api/annotations") {
                $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                $body = $reader.ReadToEnd()
                $reader.Close()
                try {
                    $null = $body | ConvertFrom-Json
                } catch {
                    Write-JsonResponse $response @{ error = "Invalid JSON body" } 400
                    continue
                }
                Set-Content -Path $AnnotationsFile -Value $body -Encoding UTF8
                Write-JsonResponse $response @{ ok = $true }
            }
            elseif ($request.HttpMethod -eq "GET" -and $path -eq "/api/groups") {
                $content = Get-Content -Path $GroupsFile -Raw -Encoding UTF8
                Write-TextResponse $response $content "application/json; charset=utf-8"
            }
            elseif ($request.HttpMethod -eq "POST" -and $path -eq "/api/groups") {
                $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                $body = $reader.ReadToEnd()
                $reader.Close()
                try {
                    $null = $body | ConvertFrom-Json
                } catch {
                    Write-JsonResponse $response @{ error = "Invalid JSON body" } 400
                    continue
                }
                Set-Content -Path $GroupsFile -Value $body -Encoding UTF8
                Write-JsonResponse $response @{ ok = $true }
            }
            elseif ($request.HttpMethod -eq "GET") {
                $relative = $path.TrimStart("/")
                if ([string]::IsNullOrWhiteSpace($relative)) { $relative = "index.html" }
                $filePath = Join-Path $PublicDir $relative
                $filePath = [System.IO.Path]::GetFullPath($filePath)

                if (-not $filePath.StartsWith([System.IO.Path]::GetFullPath($PublicDir))) {
                    Write-TextResponse $response "Forbidden" "text/plain" 403
                }
                elseif (Test-Path $filePath -PathType Leaf) {
                    $bytes = [System.IO.File]::ReadAllBytes($filePath)
                    $response.ContentType = Get-MimeType $filePath
                    $response.ContentLength64 = $bytes.Length
                    $response.OutputStream.Write($bytes, 0, $bytes.Length)
                    $response.OutputStream.Close()
                } else {
                    Write-TextResponse $response "Not Found: $relative" "text/plain" 404
                }
            }
            else {
                Write-TextResponse $response "Method Not Allowed" "text/plain" 405
            }
        } catch {
            $msg = $_.Exception.Message
            try {
                Write-JsonResponse $response @{ error = $msg } 500
            } catch {
                # Response may already be closed; ignore.
            }
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
    Write-Host "Server stopped."
}
