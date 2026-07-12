# Config Knowledge Map

A local tool for exploring dotted `key=value` `.pref` config files (e.g. Java
`application.pref`) as a searchable table and an interactive node graph, with
your own notes attached to each key so you stop forgetting what fields mean.

## Run it

Requires PowerShell (`pwsh`). Install: https://aka.ms/powershell-release

**Windows, one click:** double-click [start-server.bat](start-server.bat) (or pin
a shortcut to it) — it starts the server and opens the app in your browser.

Or from a terminal:

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
   click **Scan** to list `.pref`/`.prefs` files found there, then **Load**.
2. **Upload** — or use the file picker to load a `.pref` file directly from
   your browser without relying on the server's folder scan.
3. **Table view** — every key/value pair, with status, tags, and descriptions.
   Click a row to open the detail panel.
4. **Graph view** — same data as a zoomable/pannable node graph. Dotted key
   segments (`hi.bye.field` → `hi` → `bye` → `field`) become parent/child
   nodes. Drag nodes, scroll to zoom, drag the background to pan. Nodes with
   a useful saved description get a highlighted ring.
5. **Annotate** — click any key (table row or graph node), write a
   description and comma-separated tags, click **Save annotation**. Description
   text is always visible and searchable (this is the tool's memory); the
   highlight ring and focus-mode callouts appear only once the key is Useful.
6. **Group related fields** — use the "Groups" bar above the table to create
   a named group (e.g. "Network Connection"), then open any field's detail
   panel and check the group to add it. Groups are cross-cutting: fields
   don't need to share a dotted-key prefix (e.g. group an IP field with its
   port field even if they live under different sections). Grouped fields
   show a colored dot in the table's Groups column, and a dashed colored
   line connects them in the graph view regardless of tree distance. Use the
   **Group** dropdown in the toolbar to filter the table down to one group.
7. **Search** — filters by key, value, description, or tag across
   whichever view/table is active.
8. **Focus useful** — use the toolbar button to dim **Not interested** keys in
   table, graph, and tree views while keeping them visible and clickable. The
   active viewport is highlighted while focus mode is on. In tree view, useful
   descriptions also appear as sticky-note callouts connected to their fields
   by arrows. Focus mode is read-only: click any dimmed key to inspect its
   saved description in the detail panel, then turn focus mode off to edit.
9. **Export manual** — the toolbar button builds a Word document (`.docx`)
   from the **Useful** fields only: one numbered manual section per top-level
   key, one subsection per field showing the raw config line as a shaded
   code block (`key=value`, as it appears in the file), then the
   description and tags.
   Fields without their own note borrow the nearest section note; missing
   descriptions become visible "TODO" placeholders. Copy the sections into
   the real Software User Manual and extend them. (Uses real Word heading
   styles, so pasted sections adopt the target document's formatting.)
   Needs the PowerShell server (it assembles the `.docx`); the button is
   disabled until at least one field is Useful.

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
- `prefs/` — default folder the server scans for `.pref`/`.prefs` files. Point
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
start-server.bat      Windows one-click launcher for server.ps1
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
