# Config Knowledge Map

A local tool for exploring dotted `key=value` `.pref` config files (e.g. Java
`application.pref`) as a searchable table and an interactive node graph, with
your own notes attached to each key so you stop forgetting what fields mean.

## Run it

Requires PowerShell (`pwsh`). Install: https://aka.ms/powershell-release

```powershell
pwsh ./server.ps1
```

Then open http://localhost:8080 in a browser.

Optional parameters:

```powershell
pwsh ./server.ps1 -Port 8081 -PrefsDir "C:\path\to\your\configs"
```

## Using it

1. **Folder scan** — type a folder path (or leave blank to use `./prefs`) and
   click **Scan** to list `.pref` files found there, then **Load**.
2. **Upload** — or use the file picker to load a `.pref` file directly from
   your browser without relying on the server's folder scan.
3. **Table view** — every key/value pair, with your description and tags.
   Click a row to open the detail panel.
4. **Graph view** — same data as a zoomable/pannable node graph. Dotted key
   segments (`hi.bye.field` → `hi` → `bye` → `field`) become parent/child
   nodes. Drag nodes, scroll to zoom, drag the background to pan. Nodes with
   a saved description get a highlighted ring.
5. **Annotate** — click any key (table row or graph node), write a
   description and comma-separated tags, click **Save annotation**.
6. **Group related fields** — use the "Groups" bar above the table to create
   a named group (e.g. "Network Connection"), then open any field's detail
   panel and check the group to add it. Groups are cross-cutting: fields
   don't need to share a dotted-key prefix (e.g. group an IP field with its
   port field even if they live under different sections). Grouped fields
   show a colored dot in the table's Groups column, and a dashed colored
   line connects them in the graph view regardless of tree distance. Use the
   **Group** dropdown in the toolbar to filter the table down to one group.
7. **Search** — filters by key, value, description, or tag across whichever
   view/table is active.

## AI Usage

The header includes an AI usage badge:

```text
AI-assisted Build
Made with Ona · Claude Sonnet 5
Design, implementation & docs
```

It's there to make LLM assistance in this project's design, implementation, and
documentation visible.

## Where things are stored

- `annotations.json` (next to `server.ps1`) — your descriptions/tags,
  keyed by full dotted key. Human-readable; back it up or commit it.
- `groups.json` (next to `server.ps1`) — your custom groups (name, color,
  and the list of dotted keys assigned to each).
- Browser `localStorage` — a mirror of the same data, used automatically if
  the PowerShell server API is unreachable (e.g. you opened `public/index.html`
  directly as a file instead of through the server).
- `prefs/` — default folder the server scans for `.pref` files. Point
  `-PrefsDir` elsewhere, or type a different folder path in the UI, to scan
  your real config location instead.

## File format

Plain text, one entry per line:

```
hi.bye.field=10
ui.window.width=1024
# comments and blank lines are ignored
```

The dotted key is split on `.` to build the graph's parent/child structure.

## Project layout

```
server.ps1           PowerShell HTTP server (static files + JSON API)
public/
  index.html
  css/style.css
  js/parser.js       .pref text -> flat entries + hierarchical tree
  js/annotations.js  load/save annotations.json (+ localStorage fallback)
  js/groups.js       load/save groups.json (+ localStorage fallback)
  js/graph.js        dependency-free SVG force-directed graph
  js/app.js          UI wiring
prefs/               default folder scanned for .pref files (sample included)
annotations.json     your saved descriptions/tags (created on first run)
groups.json          your saved field groups (created on first run)
```
