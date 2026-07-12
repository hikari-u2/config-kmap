/**
 * App wiring: loading .pref files (folder scan or manual upload), rendering
 * the tree/table and graph views, search/filter, and the annotation editor.
 */

(function () {
  const state = {
    entries: [],   // flat parsed entries [{key, value, path, line}]
    tree: null,    // hierarchical tree root
    annotations: {},
    groups: { groups: [] },
    activeKey: null,
    groupFilter: '', // group id, or '' for all
    focusUseful: false,
    view: 'table', // 'table' | 'graph' | 'tree'
    pendingStatus: '', // status selected in detail panel before save (also applied immediately)
    sort: { col: '', dir: 1 }, // table sort; col '' = file order
    selectedKeys: new Set(), // multi-select for bulk status marking
  };

  const el = {
    dirInput: document.getElementById('dir-input'),
    scanBtn: document.getElementById('scan-btn'),
    fileSelect: document.getElementById('file-select'),
    loadSelectedBtn: document.getElementById('load-selected-btn'),
    fileUpload: document.getElementById('file-upload'),
    searchInput: document.getElementById('search-input'),
    searchWrap: document.querySelector('.search-wrap'),
    mainLayout: document.querySelector('.main-layout'),
    focusModeBanner: document.getElementById('focus-mode-banner'),
    tableBody: document.getElementById('table-body'),
    tableView: document.getElementById('table-view'),
    graphView: document.getElementById('graph-view'),
    treeView: document.getElementById('tree-view'),
    viewTableBtn: document.getElementById('view-table-btn'),
    viewGraphBtn: document.getElementById('view-graph-btn'),
    viewTreeBtn: document.getElementById('view-tree-btn'),
    focusUsefulBtn: document.getElementById('focus-useful-btn'),
    detailPanel: document.getElementById('detail-panel'),
    detailKey: document.getElementById('detail-key'),
    detailValue: document.getElementById('detail-value'),
    detailDescription: document.getElementById('detail-description'),
    detailDescriptionVisibility: document.getElementById('detail-description-visibility'),
    detailReadonlyNote: document.getElementById('detail-readonly-note'),
    detailTags: document.getElementById('detail-tags'),
    detailStatus: document.getElementById('detail-status'),
    detailStatusInherited: document.getElementById('detail-status-inherited'),
    saveAnnotationBtn: document.getElementById('save-annotation-btn'),
    status: document.getElementById('status-text'),
    currentFileLabel: document.getElementById('current-file-label'),
    annotatedCount: document.getElementById('annotated-count'),
    themeToggleBtn: document.getElementById('theme-toggle-btn'),
    openMenuBtn: document.getElementById('open-menu-btn'),
    openMenu: document.getElementById('open-menu'),
    uploadBtn: document.getElementById('upload-btn'),
    groupPopoverBtn: document.getElementById('group-popover-btn'),
    groupPopover: document.getElementById('group-popover'),
    groupsBar: document.getElementById('groups-bar'),
    emptyState: document.getElementById('empty-state'),
    emptyStateHint: document.getElementById('empty-state-hint'),
    emptyLoadBtn: document.getElementById('empty-load-btn'),
    groupFilterSelect: document.getElementById('group-filter-select'),
    groupsChips: document.getElementById('groups-chips'),
    newGroupName: document.getElementById('new-group-name'),
    newGroupBtn: document.getElementById('new-group-btn'),
    detailGroups: document.getElementById('detail-groups'),
    fitViewBtn: document.getElementById('fit-view-btn'),
    graphLegend: document.getElementById('graph-legend'),
    treeFitViewBtn: document.getElementById('tree-fit-view-btn'),
    treeExpandAllBtn: document.getElementById('tree-expand-all-btn'),
    selectionBar: document.getElementById('selection-bar'),
    selectionCount: document.getElementById('selection-count'),
    selectionClearBtn: document.getElementById('selection-clear-btn'),
    exportManualBtn: document.getElementById('export-manual-btn'),
    toastHost: document.getElementById('toast-host'),
  };

  const graph = window.KMapGraph.createGraph(el.graphView);
  graph.onNodeClick(async (key, isLeaf, value, e) => {
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      toggleSelected(key);
      return;
    }
    clearSelection();
    await showDetail(key, isLeaf, value);
  });
  graph.setAnnotationChecker((key) => hasUsefulDescription(key));
  graph.setGroupsChecker((key) => groupsForKey(key));
  graph.setInfoProvider((key) => {
    const entry = state.entries.find((e) => e.key === key);
    const ann = state.annotations[key];
    return {
      value: entry ? entry.value : '',
      description: descriptionForKey(key),
      tags: ann ? ann.tags : [],
    };
  });
  graph.setStatusProvider((key) => effectiveStatusForKey(key));

  const tree = window.KMapTree.createTree(el.treeView);
  tree.onNodeClick(async (key, isLeaf, value, e) => {
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      toggleSelected(key);
      return;
    }
    clearSelection();
    updateTreeExpandBtn(); // section clicks toggle collapse state
    await showDetail(key, isLeaf, value);
  });
  tree.setAnnotationChecker((key) => hasUsefulDescription(key));
  tree.setGroupsChecker((key) => groupsForKey(key));
  tree.setInfoProvider((key) => {
    const entry = state.entries.find((e) => e.key === key);
    const ann = state.annotations[key];
    return {
      value: entry ? entry.value : '',
      description: descriptionForKey(key),
      tags: ann ? ann.tags : [],
    };
  });
  tree.setStatusProvider((key) => effectiveStatusForKey(key));

  function statusForKey(key) {
    const ann = state.annotations[key];
    return ann && ann.status ? ann.status : '';
  }

  /**
   * Effective status for a node: its own status if set, otherwise the
   * nearest ancestor's status (marking a section cascades to all subnodes
   * until one of them sets its own status explicitly).
   */
  function effectiveStatusForKey(key) {
    const own = statusForKey(key);
    if (own) return { status: own, inherited: false };
    const parts = key.split('.');
    for (let i = parts.length - 1; i >= 1; i--) {
      const s = statusForKey(parts.slice(0, i).join('.'));
      if (s) return { status: s, inherited: true };
    }
    return { status: '', inherited: false };
  }

  function isEffectivelyUseful(key) {
    return effectiveStatusForKey(key).status === 'useful';
  }

  function isEffectivelyUseless(key) {
    return effectiveStatusForKey(key).status === 'useless';
  }

  // Description text is always visible and searchable (this is a memory
  // tool - a note you can't find is a note you never wrote). Only the
  // *highlights* (graph rings, focus-mode callouts) are gated on Useful.
  function hasUsefulDescription(key) {
    const ann = state.annotations[key];
    return Boolean(ann && ann.description && isEffectivelyUseful(key));
  }

  function descriptionForKey(key) {
    const ann = state.annotations[key];
    return ann && ann.description ? ann.description : '';
  }

  function groupsForKey(key) {
    return state.groups.groups.filter((g) => g.keys.includes(key));
  }

  function setStatus(msg, isError) {
    el.status.textContent = msg;
    el.status.classList.toggle('status-error', Boolean(isError));
    if (isError) showErrorToast(msg);
  }

  /**
   * Errors get a floating bubble on top of the status-bar line: the bar is
   * ambient and easy to miss, and a failed save or export the user never
   * noticed defeats a memory tool. The bubble auto-dismisses after 8 s
   * (hovering it pauses that), or on its × button.
   */
  function showErrorToast(msg) {
    // Don't let a burst of failures wallpaper the screen.
    while (el.toastHost.children.length >= 3) el.toastHost.firstChild.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'alert');

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = '!';

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = msg;

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';

    const dismiss = () => {
      if (!toast.isConnected) return;
      toast.classList.add('toast--out');
      setTimeout(() => toast.remove(), 240);
    };
    close.addEventListener('click', dismiss);
    let timer = setTimeout(dismiss, 8000);
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 3000); });

    toast.appendChild(icon);
    toast.appendChild(text);
    toast.appendChild(close);
    el.toastHost.appendChild(toast);
  }

  async function scanFolder() {
    const dir = el.dirInput.value.trim();
    setStatus('Scanning folder...');
    try {
      const url = '/api/list-prefs' + (dir ? `?dir=${encodeURIComponent(dir)}` : '');
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Error: ${data.error || res.statusText}`, true);
        return;
      }
      el.fileSelect.innerHTML = '';
      if (data.files.length === 0) {
        setStatus(`No .pref/.prefs files found in ${data.dir}`, true);
        return;
      }
      for (const f of data.files) {
        const opt = document.createElement('option');
        opt.value = f.path;
        opt.dataset.name = f.name;
        opt.textContent = `${f.name} (${f.sizeBytes} bytes)`;
        el.fileSelect.appendChild(opt);
      }
      setStatus(`Found ${data.files.length} .pref/.prefs file(s) in ${data.dir}`);
      updateEmptyState();
    } catch (err) {
      setStatus(`Could not reach server API: ${err.message}. You can still upload a file from Open.`, true);
    }
  }

  async function loadSelectedFile() {
    const path = el.fileSelect.value;
    if (!path) {
      setStatus('No file selected.', true);
      return;
    }
    setStatus('Loading file...');
    try {
      const res = await fetch(`/api/read-pref?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Error: ${data.error || res.statusText}`, true);
        return;
      }
      loadPrefText(data.content, path);
    } catch (err) {
      setStatus(`Failed to load file: ${err.message}`, true);
    }
  }

  function loadFromUpload(fileList) {
    const file = fileList[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadPrefText(reader.result, file.name);
    reader.onerror = () => setStatus(`Failed to read file: ${reader.error}`, true);
    reader.readAsText(file);
  }

  function loadPrefText(text, label) {
    state.entries = window.PrefParser.parsePrefText(text);
    state.tree = window.PrefParser.buildTree(state.entries);
    closePopovers();
    clearSelection();
    lastRowClickedKey = null;
    el.currentFileLabel.textContent = label;
    setStatus(`Loaded ${state.entries.length} entries from ${label}`);
    renderTable();
    renderGraph();
    renderTree(true);
    updateAnnotatedCount();
  }

  /**
   * True if the key's own annotation, or any ancestor section's annotation,
   * contains the filter text. Notes are often written on the section
   * ("cache - vendor said: map tiles"), and its fields are what the table
   * shows - searching the note must surface those fields.
   */
  function annotationMatches(key, f) {
    const parts = key.split('.');
    for (let i = parts.length; i >= 1; i--) {
      const ann = state.annotations[parts.slice(0, i).join('.')];
      if (!ann) continue;
      if (ann.description && ann.description.toLowerCase().includes(f)) return true;
      if (ann.tags && ann.tags.some((t) => t.toLowerCase().includes(f))) return true;
    }
    return false;
  }

  function matchesFilter(key, value, filter) {
    if (filter) {
      const f = filter.toLowerCase();
      const textMatch =
        key.toLowerCase().includes(f) ||
        value.toLowerCase().includes(f) ||
        annotationMatches(key, f);
      if (!textMatch) return false;
    }
    if (state.groupFilter) {
      const group = state.groups.groups.find((g) => g.id === state.groupFilter);
      if (!group || !group.keys.includes(key)) return false;
    }
    return true;
  }

  /**
   * The table view's empty state: shown until a file is loaded, with a
   * one-click load of whatever file is selected in the Open menu.
   */
  function updateEmptyState() {
    const hasData = state.entries.length > 0;
    el.tableView.classList.toggle('table-view--empty', !hasData);
    el.emptyState.classList.toggle('hidden', hasData);
    if (hasData) return;
    const opt = el.fileSelect.options[el.fileSelect.selectedIndex];
    if (opt) {
      el.emptyLoadBtn.textContent = `Load ${opt.dataset.name || opt.textContent}`;
      el.emptyLoadBtn.classList.remove('hidden');
      el.emptyStateHint.textContent = 'Load the file below, or pick another one from Open.';
    } else {
      el.emptyLoadBtn.classList.add('hidden');
      el.emptyStateHint.textContent = 'Scan a folder or upload a .pref file from Open.';
    }
  }

  /**
   * Sort value per column. Strings compare case-insensitively; status maps
   * to its tree-view rank (useful, unset, not-interested) so sorting by
   * Status gives the same banding as the tree.
   */
  const sortValueFor = {
    key: (e) => e.key.toLowerCase(),
    value: (e) => e.value.toLowerCase(),
    status: (e) => ({ useful: 0, '': 1, useless: 2 }[effectiveStatusForKey(e.key).status]),
    description: (e) => descriptionForKey(e.key).toLowerCase(),
    tags: (e) => {
      const ann = state.annotations[e.key];
      return ann && ann.tags ? ann.tags.join(', ').toLowerCase() : '';
    },
    groups: (e) => groupsForKey(e.key).map((g) => g.name).join(', ').toLowerCase(),
  };

  function sortedEntries(entries) {
    const { col, dir } = state.sort;
    if (!col) return entries; // file order
    const getVal = sortValueFor[col];
    // Stable sort; rows with no value for the column always sink to the
    // bottom so flipping direction reorders the data, not the blanks.
    return [...entries].sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      if ((va === '') !== (vb === '')) return va === '' ? 1 : -1;
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return 0;
    });
  }

  function updateSortIndicators() {
    for (const th of document.querySelectorAll('thead th[data-sort-col]')) {
      const active = th.dataset.sortCol === state.sort.col;
      th.classList.toggle('th-sorted-asc', active && state.sort.dir === 1);
      th.classList.toggle('th-sorted-desc', active && state.sort.dir === -1);
      if (active) {
        th.setAttribute('aria-sort', state.sort.dir === 1 ? 'ascending' : 'descending');
      } else {
        th.removeAttribute('aria-sort');
      }
    }
  }

  function renderTable() {
    updateEmptyState();
    updateSortIndicators();
    const filter = el.searchInput.value.trim();
    el.tableBody.innerHTML = '';
    lastRenderedKeys = [];

    for (const entry of sortedEntries(state.entries)) {
      if (!matchesFilter(entry.key, entry.value, filter)) continue;
      lastRenderedKeys.push(entry.key);

      const tr = document.createElement('tr');
      tr.dataset.key = entry.key;
      tr.classList.toggle('row--focus-dimmed', state.focusUseful && isEffectivelyUseless(entry.key));
      tr.classList.toggle('row--selected', state.selectedKeys.has(entry.key));

      const keyTd = document.createElement('td');
      keyTd.className = 'cell-key';
      keyTd.textContent = entry.key;

      const valueTd = document.createElement('td');
      valueTd.className = 'cell-value';
      valueTd.textContent = entry.value;

      const statusTd = document.createElement('td');
      statusTd.className = 'cell-status';
      const eff = effectiveStatusForKey(entry.key);
      if (eff.status) {
        const badge = document.createElement('span');
        badge.className =
          `status-badge status-badge--${eff.status}` + (eff.inherited ? ' status-badge--inherited' : '');
        badge.textContent = eff.status === 'useful' ? 'Useful' : 'Not interested';
        if (eff.inherited) badge.title = 'Inherited from a parent section';
        statusTd.appendChild(badge);
      }

      const descTd = document.createElement('td');
      descTd.className = 'cell-description';
      const ann = state.annotations[entry.key];
      descTd.textContent = descriptionForKey(entry.key);
      if (!descTd.textContent) descTd.classList.add('cell-description--empty');

      const tagsTd = document.createElement('td');
      tagsTd.className = 'cell-tags';
      if (ann && ann.tags && ann.tags.length) {
        tagsTd.textContent = ann.tags.join(', ');
      }

      const groupsTd = document.createElement('td');
      groupsTd.className = 'cell-groups';
      for (const g of groupsForKey(entry.key)) {
        const dot = document.createElement('span');
        dot.className = 'cell-group-dot';
        dot.style.background = g.color;
        dot.title = g.name;
        groupsTd.appendChild(dot);
      }

      tr.appendChild(keyTd);
      tr.appendChild(valueTd);
      tr.appendChild(statusTd);
      tr.appendChild(descTd);
      tr.appendChild(tagsTd);
      tr.appendChild(groupsTd);

      tr.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
          toggleSelected(entry.key);
          lastRowClickedKey = entry.key;
          return;
        }
        if (e.shiftKey && lastRowClickedKey) {
          selectRowRange(lastRowClickedKey, entry.key);
          return;
        }
        lastRowClickedKey = entry.key;
        clearSelection();
        showDetail(entry.key, true, entry.value);
      });

      el.tableBody.appendChild(tr);
    }
  }

  function renderGraph() {
    if (!state.tree) return;
    const { nodes, edges } = window.PrefParser.flattenTree(state.tree);
    graph.setData(nodes, edges);
    graph.setGroups(state.groups.groups);
    graph.setFocusUseful(state.focusUseful);
    renderGraphLegend();
    // Give the force layout a moment to spread out before framing it.
    setTimeout(() => graph.fitToView(), 400);
  }

  function updateTreeExpandBtn() {
    el.treeExpandAllBtn.textContent = tree.hasCollapsed() ? 'Expand all' : 'Collapse all';
  }

  function renderTree(resetView) {
    if (!state.tree) return;
    // resetView marks a fresh file load: also reset sections to the
    // collapsed-by-default coverage map.
    tree.setData(state.tree, resetView);
    tree.setFocusUseful(state.focusUseful);
    updateTreeExpandBtn();
    // Only snap the viewport to fit the whole tree on the initial load of
    // a file. Re-rendering after a status change (setStatusForActiveKey
    // calls this to recolor nodes) should leave pan/zoom exactly where
    // the user left it - otherwise every status click yanks the view back
    // out to the full tree, which is disorienting when working through a
    // deeply nested/zoomed-in section.
    if (resetView) setTimeout(() => tree.fitToView(), 0);
  }

  function renderGraphLegend() {
    el.graphLegend.innerHTML = '';

    const addRow = (html) => {
      const row = document.createElement('div');
      row.className = 'graph-legend-row';
      row.innerHTML = html;
      el.graphLegend.appendChild(row);
    };

    addRow('<span class="graph-legend-swatch" style="background:var(--section)"></span> Section (parent key)');
    addRow('<span class="graph-legend-swatch" style="background:var(--leaf)"></span> Useful');
    addRow('<span class="graph-legend-swatch" style="background:var(--error)"></span> Not interested');
    addRow('<span class="graph-legend-swatch" style="background:var(--text-dim)"></span> Field, status unset');
    addRow('<span class="graph-legend-swatch" style="background:var(--leaf);opacity:0.5"></span> Inherited from parent');
    addRow('<span class="graph-legend-swatch" style="background:transparent;border:2px solid var(--accent);box-sizing:border-box"></span> Useful description');
    if (state.focusUseful) {
      addRow('<span class="graph-legend-swatch" style="background:var(--dim-neutral)"></span> Dimmed: not interested');
    }

    if (state.groups.groups.length > 0) {
      addRow('<span class="graph-legend-line"></span> Custom group link');
      for (const g of state.groups.groups) {
        addRow(`<span class="graph-legend-swatch" style="background:${g.color}"></span> ${g.name}`);
      }
    }
  }

  async function showDetail(key, isLeaf, value) {
    state.activeKey = key;
    el.detailPanel.classList.remove('hidden');
    el.detailKey.textContent = key;
    el.detailValue.textContent = isLeaf ? value : '(section)';

    const ann = await window.Annotations.getAnnotation(key);
    el.detailDescription.value = ann.description || '';
    el.detailTags.value = (ann.tags || []).join(', ');
    state.pendingStatus = ann.status || '';
    updateStatusButtons();
    updateInheritedNote(key);
    updateDescriptionVisibilityNote(key);

    renderDetailGroups(key);
    applyFocusModeUi();
  }

  function updateStatusButtons() {
    for (const btn of el.detailStatus.querySelectorAll('.status-btn')) {
      btn.classList.toggle('active', btn.dataset.status === state.pendingStatus);
    }
  }

  async function setStatusForActiveKey(status) {
    if (!state.activeKey) return;
    if (state.focusUseful) {
      setStatus('Editing is disabled while Focus useful is active.', true);
      return;
    }
    state.pendingStatus = status;
    updateStatusButtons();
    const ann = await window.Annotations.getAnnotation(state.activeKey);
    await window.Annotations.setAnnotation(state.activeKey, { ...ann, status });
    state.annotations = await window.Annotations.loadAnnotations();
    updateInheritedNote(state.activeKey);
    updateDescriptionVisibilityNote(state.activeKey);
    renderTable();
    renderTree();
    graph.refresh();
    updateAnnotatedCount();
    setStatus(
      `Marked "${state.activeKey}" as ${status || 'unset'} — subnodes without their own status inherit it.`
    );
  }

  /* ------------------------------------------------- multi-select + bulk */

  // Anchor for shift-click range selection in the table (last clicked row).
  let lastRowClickedKey = null;
  // Table row order as last rendered, so shift-click ranges follow the
  // current sort/filter, not the file order.
  let lastRenderedKeys = [];

  function toggleSelected(key) {
    if (state.selectedKeys.has(key)) state.selectedKeys.delete(key);
    else state.selectedKeys.add(key);
    selectionChanged();
  }

  function selectRowRange(fromKey, toKey) {
    const a = lastRenderedKeys.indexOf(fromKey);
    const b = lastRenderedKeys.indexOf(toKey);
    if (a === -1 || b === -1) {
      toggleSelected(toKey);
      return;
    }
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      state.selectedKeys.add(lastRenderedKeys[i]);
    }
    selectionChanged();
  }

  function clearSelection() {
    if (state.selectedKeys.size === 0) return;
    state.selectedKeys.clear();
    selectionChanged();
  }

  /**
   * Repaint everything that shows selection. Bulk mode is for quick status
   * triage, so the detail panel (description editing) closes while a
   * selection is active - descriptions are deliberately out of the way here.
   */
  function selectionChanged() {
    const n = state.selectedKeys.size;
    el.selectionBar.classList.toggle('hidden', n === 0);
    el.selectionCount.textContent = `${n} selected`;
    if (n > 0) {
      el.detailPanel.classList.add('hidden');
      state.activeKey = null;
    }
    for (const tr of el.tableBody.children) {
      tr.classList.toggle('row--selected', state.selectedKeys.has(tr.dataset.key));
    }
    tree.setSelectedKeys(new Set(state.selectedKeys));
    graph.setSelectedKeys(new Set(state.selectedKeys));
  }

  async function applyBulkStatus(status) {
    if (state.focusUseful) {
      setStatus('Editing is disabled while Focus useful is active.', true);
      return;
    }
    if (state.selectedKeys.size === 0) return;
    const all = await window.Annotations.loadAnnotations();
    for (const key of state.selectedKeys) {
      const existing = all[key] || { description: '', tags: [], status: '' };
      all[key] = { ...existing, status };
    }
    await window.Annotations.saveAnnotations(all);
    state.annotations = all;
    const n = state.selectedKeys.size;
    clearSelection();
    renderTable();
    renderTree();
    graph.refresh();
    updateAnnotatedCount();
    const label = status === 'useful' ? 'Useful' : status === 'useless' ? 'Not interested' : 'unset';
    setStatus(`Marked ${n} item(s) as ${label} — subnodes without their own status inherit it.`);
  }

  function updateInheritedNote(key) {
    const own = statusForKey(key);
    const eff = effectiveStatusForKey(key);
    if (!own && eff.inherited) {
      const label = eff.status === 'useful' ? 'Useful' : 'Not interested';
      el.detailStatusInherited.textContent = `Inheriting "${label}" from a parent section.`;
      el.detailStatusInherited.classList.remove('hidden');
    } else {
      el.detailStatusInherited.classList.add('hidden');
    }
  }

  function updateDescriptionVisibilityNote(key) {
    const ann = state.annotations[key] || {};
    const hasDescription = Boolean(ann.description);
    const notHighlighted = hasDescription && !isEffectivelyUseful(key);
    if (notHighlighted) {
      el.detailDescriptionVisibility.textContent =
        'Always visible and searchable; gets the highlight ring and focus-mode callout once this key is Useful.';
      el.detailDescriptionVisibility.classList.remove('hidden');
    } else {
      el.detailDescriptionVisibility.classList.add('hidden');
    }
  }

  function renderDetailGroups(key) {
    el.detailGroups.innerHTML = '';
    if (state.groups.groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'detail-groups-empty';
      empty.textContent = 'No groups yet. Create one with the "+ Group" button in the toolbar.';
      el.detailGroups.appendChild(empty);
      return;
    }
    for (const g of state.groups.groups) {
      const row = document.createElement('label');
      row.className = 'detail-group-option';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = g.keys.includes(key);
      checkbox.disabled = state.focusUseful;
      checkbox.addEventListener('change', () => toggleKeyInGroup(key, g.id, checkbox.checked));

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = g.color;

      const label = document.createElement('span');
      label.textContent = g.name;

      row.appendChild(checkbox);
      row.appendChild(swatch);
      row.appendChild(label);
      el.detailGroups.appendChild(row);
    }
  }

  async function toggleKeyInGroup(key, groupId, checked) {
    if (state.focusUseful) {
      setStatus('Editing is disabled while Focus useful is active.', true);
      renderDetailGroups(key);
      return;
    }
    const current = groupsForKey(key).map((g) => g.id);
    const next = checked ? [...new Set([...current, groupId])] : current.filter((id) => id !== groupId);
    state.groups = await window.Groups.setKeyGroups(key, next);
    renderGroupsBar();
    renderTable();
    // Update the graph's group links/dots in place instead of re-laying out
    // the whole graph (renderGraph -> setData restarts the force simulation
    // from random positions and re-frames the viewport - disorienting and
    // expensive for a one-checkbox change).
    graph.setGroups(state.groups.groups);
    renderTree();
    setStatus(`Updated groups for "${key}"`);
  }

  async function saveCurrentAnnotation() {
    if (!state.activeKey) return;
    if (state.focusUseful) {
      setStatus('Editing is disabled while Focus useful is active.', true);
      return;
    }
    const description = el.detailDescription.value.trim();
    const tags = el.detailTags.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    await window.Annotations.setAnnotation(state.activeKey, { description, tags, status: state.pendingStatus });
    state.annotations = await window.Annotations.loadAnnotations();
    setStatus(`Saved annotation for "${state.activeKey}"`);
    updateDescriptionVisibilityNote(state.activeKey);
    renderTable();
    // Annotations only change colors/badges, not graph structure: recolor
    // the existing graph elements instead of re-laying out from scratch.
    graph.refresh();
    renderTree();
    updateAnnotatedCount();
  }

  function updateAnnotatedCount() {
    const total = state.entries.length;
    const annotated = state.entries.filter((e) => hasUsefulDescription(e.key)).length;
    el.annotatedCount.textContent = `${annotated} / ${total} useful descriptions`;
    updateExportBtn();
  }

  /* -------------------------------------------------- manual export (docx) */

  function updateExportBtn() {
    const count = state.entries.filter((e) => isEffectivelyUseful(e.key)).length;
    el.exportManualBtn.disabled = count === 0;
    el.exportManualBtn.title = count === 0
      ? 'Mark fields as Useful to export them as manual sections'
      : `Word document of the ${count} Useful field(s) and their notes, as manual sections`;
  }

  /**
   * Useful fields grouped into manual sections by top-level key. A field
   * without its own note borrows the nearest ancestor section's note
   * (attributed), so the manual writer gets whatever context exists.
   */
  function usefulExportSections() {
    const sections = [];
    const byName = new Map();
    for (const entry of state.entries) {
      if (!isEffectivelyUseful(entry.key)) continue;
      const top = entry.key.split('.')[0];
      if (!byName.has(top)) {
        const secAnn = state.annotations[top];
        const sec = {
          name: top,
          description: secAnn && secAnn.description ? secAnn.description : '',
          fields: [],
        };
        byName.set(top, sec);
        sections.push(sec);
      }
      const ann = state.annotations[entry.key];
      let description = ann && ann.description ? ann.description : '';
      if (!description) {
        // Walk up to (but not including) the top-level section - its note
        // already heads the section in the document.
        const parts = entry.key.split('.');
        for (let i = parts.length - 1; i >= 2; i--) {
          const parentKey = parts.slice(0, i).join('.');
          const parentAnn = state.annotations[parentKey];
          if (parentAnn && parentAnn.description) {
            description = `${parentAnn.description} (note on ${parentKey})`;
            break;
          }
        }
      }
      byName.get(top).fields.push({
        key: entry.key,
        value: entry.value,
        description,
        tags: ann && ann.tags ? ann.tags : [],
      });
    }
    return sections;
  }

  async function exportManual() {
    const sections = usefulExportSections();
    const count = sections.reduce((n, s) => n + s.fields.length, 0);
    if (count === 0) {
      setStatus('Nothing to export - mark fields as Useful first.', true);
      return;
    }
    setStatus('Building manual…');
    try {
      const res = await fetch('/api/export-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceFile: el.currentFileLabel.textContent || 'config',
          generated: new Date().toISOString().slice(0, 10),
          sections,
        }),
      });
      if (!res.ok) throw new Error(res.statusText || `HTTP ${res.status}`);
      const blob = await res.blob();
      const base = (el.currentFileLabel.textContent || 'config')
        .split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${base}-manual.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setStatus(`Exported ${count} Useful field(s) to ${a.download} — copy the sections into the manual and extend.`);
    } catch (err) {
      setStatus(`Export failed: ${err.message}. The PowerShell server must be running.`, true);
    }
  }

  function renderGroupsBar() {
    el.groupsChips.innerHTML = '';
    el.groupFilterSelect.innerHTML = '<option value="">All groups</option>';
    // The chips bar only exists when there is something to show.
    el.groupsBar.classList.toggle('hidden', state.groups.groups.length === 0);

    for (const g of state.groups.groups) {
      const count = g.keys.length;

      const chip = document.createElement('span');
      chip.className = 'group-chip';
      chip.style.background = g.color;
      chip.title = g.keys.join(', ') || '(no fields assigned yet)';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = g.name;
      chip.appendChild(nameSpan);

      const countSpan = document.createElement('span');
      countSpan.className = 'group-chip-count';
      countSpan.textContent = `(${count})`;
      chip.appendChild(countSpan);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'group-chip-delete';
      deleteBtn.textContent = '×';
      deleteBtn.title = `Delete "${g.name}"`;
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete group "${g.name}"? Fields keep their data; only the grouping is removed.`)) return;
        state.groups = await window.Groups.deleteGroup(g.id);
        if (state.groupFilter === g.id) state.groupFilter = '';
        renderGroupsBar();
        renderTable();
        // Drop the group's links/dots in place; a full renderGraph would
        // re-run the force layout and lose the user's positions and view.
        graph.setGroups(state.groups.groups);
        renderGraphLegend();
        renderTree();
        if (state.activeKey) renderDetailGroups(state.activeKey);
      });
      chip.appendChild(deleteBtn);

      el.groupsChips.appendChild(chip);

      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = `${g.name} (${count})`;
      el.groupFilterSelect.appendChild(opt);
    }

    el.groupFilterSelect.value = state.groupFilter;
  }

  async function addNewGroup() {
    if (state.focusUseful) {
      setStatus('Editing is disabled while Focus useful is active.', true);
      return;
    }
    const name = el.newGroupName.value.trim();
    if (!name) {
      setStatus('Enter a group name first.', true);
      return;
    }
    const group = await window.Groups.createGroup(name);
    state.groups = await window.Groups.loadGroups();
    el.newGroupName.value = '';
    renderGroupsBar();
    closePopovers();
    setStatus(`Created group "${group.name}". Open a field's detail panel to assign it.`);
  }

  function switchView(view) {
    state.view = view;
    // Search only filters the table, so it only appears with the table.
    el.searchWrap.classList.toggle('hidden', view !== 'table');
    el.tableView.classList.toggle('hidden', view !== 'table');
    el.graphView.classList.toggle('hidden', view !== 'graph');
    el.treeView.classList.toggle('hidden', view !== 'tree');
    el.viewTableBtn.classList.toggle('active', view === 'table');
    el.viewGraphBtn.classList.toggle('active', view === 'graph');
    el.viewTreeBtn.classList.toggle('active', view === 'tree');
    if (view === 'graph') graph.resize();
    if (view === 'tree') {
      tree.resize();
      renderTree();
      if (state.focusUseful) setTimeout(() => tree.fitToView(), 0);
    }
    applyFocusModeUi();
  }

  function toggleFocusUseful() {
    state.focusUseful = !state.focusUseful;
    el.focusUsefulBtn.classList.toggle('active', state.focusUseful);
    el.focusUsefulBtn.setAttribute('aria-pressed', String(state.focusUseful));
    applyFocusModeUi();
    renderTable();
    graph.setFocusUseful(state.focusUseful);
    tree.setFocusUseful(state.focusUseful);
    updateTreeExpandBtn();
    renderGraphLegend();
    if (state.focusUseful && state.view === 'tree') setTimeout(() => tree.fitToView(), 0);
    setStatus(state.focusUseful ? 'Focusing Useful keys. Not interested keys are dimmed.' : 'Showing all keys at normal emphasis.');
  }

  function applyFocusModeUi() {
    el.mainLayout.classList.toggle('focus-mode-active', state.focusUseful);
    el.focusModeBanner.classList.toggle('hidden', !state.focusUseful);
    for (const viewEl of [el.tableView, el.graphView, el.treeView]) {
      viewEl.classList.toggle('focus-viewport-active', state.focusUseful && !viewEl.classList.contains('hidden'));
    }

    el.detailPanel.classList.toggle('detail-panel--readonly', state.focusUseful);
    el.detailReadonlyNote.classList.toggle('hidden', !state.focusUseful);
    el.detailDescription.disabled = state.focusUseful;
    el.detailTags.disabled = state.focusUseful;
    el.saveAnnotationBtn.disabled = state.focusUseful;
    el.newGroupName.disabled = state.focusUseful;
    el.newGroupBtn.disabled = state.focusUseful;
    el.groupPopoverBtn.disabled = state.focusUseful;
    for (const btn of el.detailStatus.querySelectorAll('.status-btn')) {
      btn.disabled = state.focusUseful;
    }
    for (const checkbox of el.detailGroups.querySelectorAll('input[type="checkbox"]')) {
      checkbox.disabled = state.focusUseful;
    }
  }

  // Theme: index.html sets data-theme before first paint (saved choice or
  // OS setting). The toggle stores an explicit choice; until one is stored,
  // the app keeps following OS theme changes live.
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // The icon-only button names the theme you would switch TO.
    const label = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    el.themeToggleBtn.title = label;
    el.themeToggleBtn.setAttribute('aria-label', label);
  }
  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  el.themeToggleBtn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem('ckm-theme', next); } catch (e) { /* ignore */ }
  });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      let saved = null;
      try { saved = localStorage.getItem('ckm-theme'); } catch (err) { /* ignore */ }
      if (saved !== 'light' && saved !== 'dark') applyTheme(e.matches ? 'light' : 'dark');
    });
  }

  // Popovers (Open menu, new group): one open at a time, closed by a click
  // outside, Escape, or completing the action inside.
  const popovers = [
    { btn: el.openMenuBtn, panel: el.openMenu },
    { btn: el.groupPopoverBtn, panel: el.groupPopover },
  ];
  function closePopovers() {
    for (const p of popovers) {
      p.panel.classList.add('hidden');
      p.btn.setAttribute('aria-expanded', 'false');
    }
  }
  for (const p of popovers) {
    p.btn.addEventListener('click', () => {
      const willOpen = p.panel.classList.contains('hidden');
      closePopovers();
      if (willOpen) {
        p.panel.classList.remove('hidden');
        p.btn.setAttribute('aria-expanded', 'true');
        const field = p.panel.querySelector('input[type="text"]');
        if (field) field.focus();
      }
    });
  }
  document.addEventListener('click', (e) => {
    if (!popovers.some((p) => p.btn.contains(e.target) || p.panel.contains(e.target))) closePopovers();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopovers();
      clearSelection();
    }
  });
  // Shift+click is range-select in the table; stop the browser from also
  // sweeping a text selection across the rows.
  el.tableBody.addEventListener('mousedown', (e) => {
    if (e.shiftKey) e.preventDefault();
  });
  for (const btn of el.selectionBar.querySelectorAll('.status-btn')) {
    btn.addEventListener('click', () => applyBulkStatus(btn.dataset.status));
  }
  el.selectionClearBtn.addEventListener('click', clearSelection);
  el.exportManualBtn.addEventListener('click', exportManual);

  el.scanBtn.addEventListener('click', scanFolder);
  el.loadSelectedBtn.addEventListener('click', loadSelectedFile);
  el.uploadBtn.addEventListener('click', () => el.fileUpload.click());
  el.fileUpload.addEventListener('change', (e) => {
    closePopovers();
    loadFromUpload(e.target.files);
  });
  el.emptyLoadBtn.addEventListener('click', loadSelectedFile);
  el.fileSelect.addEventListener('change', updateEmptyState);
  el.searchInput.addEventListener('input', renderTable);
  // Header click cycles the column: ascending, descending, then back to
  // the file's own order (line order matters in a config file).
  for (const th of document.querySelectorAll('thead th[data-sort-col]')) {
    th.addEventListener('click', () => {
      const col = th.dataset.sortCol;
      if (state.sort.col !== col) {
        state.sort = { col, dir: 1 };
      } else if (state.sort.dir === 1) {
        state.sort.dir = -1;
      } else {
        state.sort = { col: '', dir: 1 };
      }
      renderTable();
    });
  }
  el.saveAnnotationBtn.addEventListener('click', saveCurrentAnnotation);
  el.viewTableBtn.addEventListener('click', () => switchView('table'));
  el.viewGraphBtn.addEventListener('click', () => switchView('graph'));
  el.viewTreeBtn.addEventListener('click', () => switchView('tree'));
  el.focusUsefulBtn.addEventListener('click', toggleFocusUseful);
  el.newGroupBtn.addEventListener('click', addNewGroup);
  el.fitViewBtn.addEventListener('click', () => graph.fitToView());
  el.treeFitViewBtn.addEventListener('click', () => tree.fitToView());
  el.treeExpandAllBtn.addEventListener('click', () => {
    if (tree.hasCollapsed()) {
      tree.expandAll();
      // Fitting 250 rows into the viewport would zoom out to a sliver;
      // frame the top at a readable zoom and let the user pan down.
      tree.fitToTop();
    } else {
      // Collapse keeps the user's zoom level; just re-anchor to the top
      // so they aren't left staring at empty space below the folded tree.
      tree.collapseAll();
      tree.anchorTop();
    }
    updateTreeExpandBtn();
  });
  for (const btn of el.detailStatus.querySelectorAll('.status-btn')) {
    btn.addEventListener('click', () => setStatusForActiveKey(btn.dataset.status));
  }
  el.newGroupName.addEventListener('keydown', (e) => { if (e.key === 'Enter') addNewGroup(); });
  el.groupFilterSelect.addEventListener('change', () => {
    state.groupFilter = el.groupFilterSelect.value;
    renderTable();
  });

  async function init() {
    state.annotations = await window.Annotations.loadAnnotations();
    state.groups = await window.Groups.loadGroups();
    renderGroupsBar();
    switchView('table');
    applyFocusModeUi();
    await scanFolder();
    updateEmptyState();
  }

  init();
})();
