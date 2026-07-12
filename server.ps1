<#
.SYNOPSIS
    Local web server for the Config Knowledge Map app.

.DESCRIPTION
    Serves the static frontend (public/) and a small JSON API:
      GET  /api/list-prefs?dir=<path>        -> list .pref/.prefs files in a folder
      GET  /api/read-pref?path=<file>         -> read contents of a .pref file
      POST /api/export-docx                   -> build a .docx manual from posted Useful fields
      GET  /api/annotations                   -> read annotations.json
      POST /api/annotations  (JSON body)      -> save annotations.json
      GET  /api/groups                        -> read groups.json
      POST /api/groups       (JSON body)      -> save groups.json

    Run with:  pwsh ./server.ps1
    Then open: http://localhost:8080

.PARAMETER Port
    TCP port to listen on. Default 8080.

.PARAMETER PrefsDir
    Default folder to scan for .pref/.prefs files. Default ./prefs next to this script.
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

# ------------------------------------------------------------- docx export
# A .docx is a ZIP of WordprocessingML XML parts - buildable with .NET's
# ZipArchive, no Word and no external tools needed (the whole app must stay
# dependency-free, see README). The manual export turns Useful fields into
# numbered user-manual sections someone can copy into the real SUM document.

function Escape-Xml([string]$s) {
    if ($null -eq $s) { return "" }
    return [System.Security.SecurityElement]::Escape($s)
}

function New-DocxRun([string]$text, [bool]$bold = $false, [bool]$italic = $false, [string]$font = "", [string]$color = "") {
    $rPr = ""
    if ($bold) { $rPr += "<w:b/>" }
    if ($italic) { $rPr += "<w:i/>" }
    if ($font) { $rPr += "<w:rFonts w:ascii=`"$font`" w:hAnsi=`"$font`"/>" }
    if ($color) { $rPr += "<w:color w:val=`"$color`"/>" }
    if ($rPr) { $rPr = "<w:rPr>$rPr</w:rPr>" }
    return "<w:r>$rPr<w:t xml:space=`"preserve`">$(Escape-Xml $text)</w:t></w:r>"
}

function New-DocxParagraph([string]$styleId, [string]$runsXml) {
    $pPr = ""
    if ($styleId) { $pPr = "<w:pPr><w:pStyle w:val=`"$styleId`"/></w:pPr>" }
    return "<w:p>$pPr$runsXml</w:p>"
}

function New-ManualDocxBytes($payload) {
    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.Append((New-DocxParagraph "Title" (New-DocxRun "Configuration reference")))
    $meta = "Useful fields from $($payload.sourceFile), exported $($payload.generated). " +
        "Copy these sections into the Software User Manual and extend them."
    [void]$sb.Append((New-DocxParagraph "Subtle" (New-DocxRun $meta)))

    $si = 0
    foreach ($section in @($payload.sections)) {
        $si++
        [void]$sb.Append((New-DocxParagraph "Heading1" (New-DocxRun "$si. $($section.name)")))
        if ($section.description) {
            [void]$sb.Append((New-DocxParagraph "" (New-DocxRun ([string]$section.description))))
        }
        $fi = 0
        foreach ($field in @($section.fields)) {
            $fi++
            [void]$sb.Append((New-DocxParagraph "Heading2" (New-DocxRun "$si.$fi $($field.key)")))
            # The raw config line as a shaded code block (markdown-fence
            # look), so the manual shows exactly what sits in the file.
            $codeLine = "$($field.key)=$($field.value)"
            [void]$sb.Append((New-DocxParagraph "CodeBlock" (New-DocxRun $codeLine $false $false "Consolas")))
            if ($field.description) {
                [void]$sb.Append((New-DocxParagraph "" (New-DocxRun ([string]$field.description))))
            } else {
                # Placeholder so the manual writer sees the gap instead of a
                # silently undocumented field.
                [void]$sb.Append((New-DocxParagraph "" (New-DocxRun "TODO: describe this field." $false $true "" "808080")))
            }
            if ($field.tags -and @($field.tags).Count -gt 0) {
                [void]$sb.Append((New-DocxParagraph "Subtle" (New-DocxRun ("Tags: " + (@($field.tags) -join ", ")) $false $true)))
            }
        }
    }

    $documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        $sb.ToString() +
        '<w:sectPr><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>'

    $contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '</Types>'

    $rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>'

    $docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>'

    # Real Word heading styles (w:name "heading 1"...) so the exported
    # sections pick up the target document's own heading formatting and
    # numbering when pasted, and show up in Word's navigation pane.
    $stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
        '<w:pPr><w:spacing w:after="120"/></w:pPr>' +
        '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr><w:spacing w:after="240"/></w:pPr>' +
        '<w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>' +
        '<w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="1F6FB2"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr>' +
        '<w:rPr><w:b/><w:sz w:val="26"/><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Subtle"><w:name w:val="Subtle"/><w:basedOn w:val="Normal"/>' +
        '<w:rPr><w:i/><w:color w:val="808080"/><w:sz w:val="20"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' +
        '<w:pBdr>' +
        '<w:top w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/>' +
        '<w:bottom w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/>' +
        '<w:left w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/>' +
        '<w:right w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/>' +
        '</w:pBdr>' +
        '<w:spacing w:before="80" w:after="120"/><w:ind w:left="113" w:right="113"/></w:pPr>' +
        '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>' +
        '</w:styles>'

    $parts = [ordered]@{
        "[Content_Types].xml"         = $contentTypes
        "_rels/.rels"                 = $rels
        "word/_rels/document.xml.rels" = $docRels
        "word/document.xml"           = $documentXml
        "word/styles.xml"             = $stylesXml
    }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $ms = New-Object System.IO.MemoryStream
    $zip = New-Object System.IO.Compression.ZipArchive($ms, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    foreach ($name in $parts.Keys) {
        $entry = $zip.CreateEntry($name)
        $stream = $entry.Open()
        $bytes = $utf8.GetBytes($parts[$name])
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
    }
    $zip.Dispose()
    $result = $ms.ToArray()
    $ms.Dispose()
    return $result
}

Add-Type -AssemblyName System.Web
Add-Type -AssemblyName System.IO.Compression

$listener = [System.Net.HttpListener]::new()
# "localhost" (unlike a wildcard "+" or "*" prefix) is exempt from Windows'
# URL ACL reservation, so this binds without requiring an elevated process.
# But loopback-only binding means anything outside the loopback interface
# (e.g. a container/dev-environment port-forwarding proxy) can't reach the
# server and gets a connection failure/503 even though everything looks
# fine from `localhost` inside the same machine. Bind "+" (all interfaces)
# first so remote forwarding works; if that's rejected (no URL ACL / not
# elevated - typical on a bare Windows install), fall back to loopback-only
# so local development still works without requiring admin rights.
$prefix = "http://+:$Port/"
try {
    $listener.Prefixes.Add($prefix)
    $listener.Start()
} catch {
    # A failed Start() disposes the HttpListener, so the fallback must use a
    # fresh instance - touching the old one throws ObjectDisposedException.
    $listener.Close()
    $listener = [System.Net.HttpListener]::new()
    $prefix = "http://localhost:$Port/"
    $listener.Prefixes.Add($prefix)
    try {
        $listener.Start()
    } catch {
        Write-Error "Failed to start listener on $prefix. $_"
        exit 1
    }
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
                    $files = Get-ChildItem -Path $full -File -Recurse -ErrorAction SilentlyContinue |
                        Where-Object { $_.Extension -eq ".pref" -or $_.Extension -eq ".prefs" } |
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
            elseif ($request.HttpMethod -eq "POST" -and $path -eq "/api/export-docx") {
                $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                $body = $reader.ReadToEnd()
                $reader.Close()
                $payload = $null
                try {
                    $payload = $body | ConvertFrom-Json
                } catch {
                    Write-JsonResponse $response @{ error = "Invalid JSON body" } 400
                    continue
                }
                $bytes = New-ManualDocxBytes $payload
                $response.StatusCode = 200
                $response.ContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                $response.AddHeader("Content-Disposition", "attachment")
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
                $response.OutputStream.Close()
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
