# Useful-Only Description Visualization Spec

> **Partially superseded (July 2026).** Hiding description *text* from the
> table, tooltips, and search turned out to be a trap for a memory tool:
> notes on not-yet-Useful keys became unfindable, which defeats the tool's
> purpose (users return after months and search by meaning). Current policy:
> description text is **always visible and searchable** everywhere; only the
> *highlights* — graph/tree annotation rings, focus-mode sticky-note
> callouts, and the header's annotated count — remain gated on effective
> `Useful` status. The sections below describe the original design and are
> kept for the highlight-gating rationale, which still applies.

## Goal

Users can mark config keys or sections as `Useful`, `Not interested`, or unset. Descriptions may exist on any annotated key, but descriptions should only matter visually when the key is effectively `Useful`.

When a key is marked `Not interested`/useless, the app should stop showing that description in normal browsing and visualization. The saved description should remain available in the detail panel so the user can recover it by changing the key back to `Useful`.

## Requirements

- Treat description visibility as status-aware.
- A key's effective status is the same status model already used by the app:
  - A key's own `status` wins.
  - If unset, it inherits the nearest parent section's `status`.
  - If no own or inherited status exists, the effective status is unset.
- Only keys with effective status `Useful` should have descriptions treated as visually important.
- Hide or de-emphasize descriptions for keys whose effective status is `Not interested`.
- Do not delete existing descriptions or tags when a key is marked `Not interested`.
- Preserve editing access:
  - The detail panel should continue to show the saved description and tags for the selected key.
  - The user can edit or clear that data manually.
  - If the key becomes effectively `Useful` again, the saved description becomes visible in passive views again.
- Update passive views so useless descriptions are not presented as important:
  - Table `Description` cells should be empty for effectively `Not interested` rows.
  - Graph and tree annotation rings should only appear for effectively `Useful` nodes with a description.
  - Graph and tree tooltips should only show description text when the hovered node is effectively `Useful`.
  - The annotated count in the header should count only entries with descriptions that are effectively `Useful`.
  - Search should not match hidden descriptions for effectively `Not interested` keys.
- Add a `Focus useful` control in the toolbar.
  - When enabled, the active table/graph/tree viewport is highlighted with a clear focus-mode frame and banner.
  - When enabled, effectively `Not interested` rows, graph nodes, tree nodes, and related edges are greyed out/dimmed.
  - In tree view, useful nodes with visible descriptions render sticky-note callouts connected to the node by an arrow.
  - When enabled, annotation/status/group editing controls are disabled so focus mode behaves as a read-only inspection mode.
  - Dimmed keys remain visible and clickable so the user can preserve hierarchy context and open the detail panel.
  - When disabled, all keys return to normal emphasis while description visibility remains useful-only.
- Keep status visualization intact:
  - Useful nodes still appear on the useful/right/green side.
  - Not interested nodes still appear on the not-interested/left/red side.
  - Inherited status indicators continue to work.
- Useless nodes should still be clickable/selectable in all views.

## Constraints

- Keep the feature local to the current static browser app and PowerShell JSON persistence.
- Do not introduce external dependencies.
- Do not change the annotation storage schema unless implementation proves it necessary.
- Maintain existing offline/localStorage fallback behavior.
- Avoid destructive behavior: no automatic deletion of annotations, tags, groups, or statuses.
- Preserve current group behavior unless directly affected by description visibility.
- Keep the UI language consistent with the existing app, which currently uses `Useful` and `Not interested`.

## Architecture

The current app stores annotations in `annotations.json` and browser `localStorage` through `public/js/annotations.js`. Each annotation currently has:

```json
{
  "description": "...",
  "tags": ["..."],
  "status": "useful"
}
```

The app already computes effective status in `public/js/app.js` with `effectiveStatusForKey(key)`. That function should remain the source of truth for deciding whether a description is visually important.

Add a small helper in `public/js/app.js`, conceptually:

```js
function hasUsefulDescription(key) {
  const ann = state.annotations[key];
  return Boolean(
    ann &&
    ann.description &&
    effectiveStatusForKey(key).status === 'useful'
  );
}
```

Use this helper anywhere the app currently treats any saved description as a visible/important annotation.

Expected integration points:

- `graph.setAnnotationChecker(...)`
  - Change from "has any description" to "has useful description".
- `tree.setAnnotationChecker(...)`
  - Change from "has any description" to "has useful description".
- `graph.setInfoProvider(...)`
  - Return description only for effectively useful keys.
  - Tags may remain available, but descriptions should be hidden when not useful.
- `tree.setInfoProvider(...)`
  - Same as graph.
- `matchesFilter(...)`
  - Match `description` only when `hasUsefulDescription(key)` is true.
  - Keep key, value, and tag matching unchanged unless later product direction says tags should also be useful-only.
- `renderTable()`
  - Show the description cell text only when `hasUsefulDescription(entry.key)` is true.
  - Otherwise render the empty description state.
- `updateAnnotatedCount()`
  - Count only entries where `hasUsefulDescription(entry.key)` is true.
- `Focus useful` toolbar control
  - Track a `focusUseful` boolean in app state.
  - Toggle a focus-mode frame and banner on the active viewport.
  - Apply a table row dimming class for effectively useless rows.
  - Pass the flag to graph and tree renderers through `setFocusUseful(enabled)`.
  - Disable detail-panel editing controls, status buttons, group assignment checkboxes, and group creation controls while focus mode is active.
- Tree focus callouts
  - Add a dedicated SVG callout layer in the tree renderer.
  - Render callouts only when `focusUseful` is enabled and `infoForNodeFn(key).description` is visible.
  - Draw connector arrows from the source node to a sticky-note-style description box.
  - Include callout bounds in tree `fitToView()` so notes are reachable when focusing.
- `renderGraphLegend()`
  - Rename the annotation legend label from `Has description` to `Useful description` or equivalent.
- Tree legend
  - Add or update a legend row if annotation rings are shown there, so the meaning is clear.

The detail panel should continue to call `Annotations.getAnnotation(key)` and show raw saved `description` and `tags` regardless of status. This keeps the data recoverable and makes the hidden state reversible.

## Implementation Steps

1. Add status-aware description helpers in `public/js/app.js`.
   - `hasUsefulDescription(key)`
   - Optionally `visibleDescriptionForKey(key)` to avoid repeating logic.

2. Update table rendering.
   - Use the helper for the `Description` column.
   - Keep the empty placeholder styling when a description is hidden.
   - Dim effectively useless rows when `Focus useful` is enabled.

3. Update graph and tree data providers.
   - Annotation ring checkers should use useful-only visibility.
   - Tooltip info providers should hide descriptions unless useful.
   - Keep click behavior and detail panel behavior unchanged.
   - Add focus mode renderer state so effectively useless nodes and edges can be greyed out without removing them.
   - In tree focus mode, render sticky-note callouts for visible useful descriptions and keep the note clickable through to the same detail panel.

4. Update search/count behavior.
   - Search should not surface a `Not interested` key only because of a hidden description.
   - Header count should reflect useful visible descriptions only.

5. Update legends and documentation.
   - Change labels that imply all descriptions are visualized.
   - Update `README.md` if implementation proceeds, especially the table, graph, tree, and annotation descriptions.

6. Verify manually in the browser.
   - Load the sample `.pref` file.
   - Add descriptions to useful, not-interested, inherited-useful, and inherited-not-interested keys.
   - Confirm only effectively useful descriptions appear in passive views.

## Success Criteria

- A key marked `Useful` with a saved description shows that description in the table and tooltips and receives the annotation ring in graph/tree views.
- A key marked `Not interested` with a saved description does not show that description in the table or tooltips and does not receive the annotation ring.
- A key inheriting `Useful` from a parent behaves like useful for description visualization.
- A key inheriting `Not interested` from a parent behaves like not interested for description visualization.
- The detail panel still shows and saves the raw description for any selected key, regardless of status.
- Switching a key from `Not interested` back to `Useful` restores its previously saved description in passive views without retyping.
- Header annotated count includes only effectively useful entries with descriptions.
- Searching for words that only appear in hidden useless descriptions does not return those rows.
- Enabling `Focus useful` dims effectively `Not interested` keys in table, graph, and tree views while leaving them selectable.
- While `Focus useful` is enabled, the active viewport has a visible focus-mode highlight and editing controls are disabled.
- In tree view with `Focus useful` enabled, each visible useful description appears as a sticky note connected to its node by an arrow.
- Existing annotation and group JSON files remain compatible.
- No external libraries or persistence migrations are required.
