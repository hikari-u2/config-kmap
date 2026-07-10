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
    view: 'table', // 'table' | 'graph' | 'tree'
    pendingStatus: '', // status selected in detail panel before save (also applied immediately)
  };

  const el = {
    dirInput: document.getElementById('dir-input'),
    scanBtn: document.getElementById('scan-btn'),
    fileSelect: document.getElementById('file-select'),
    loadSelectedBtn: document.getElementById('load-selected-btn'),
    fileUpload: document.getElementById('file-upload'),
    searchInput: document.getElementById('search-input'),
    tableBody: document.getElementById('table-body'),
    tableView: document.getElementById('table-view'),
    graphView: document.getElementById('graph-view'),
    treeView: document.getElementById('tree-view'),
    viewTableBtn: document.getElementById('view-table-btn'),
    viewGraphBtn: document.getElementById('view-graph-btn'),
    viewTreeBtn: document.getElementById('view-tree-btn'),
    detailPanel: document.getElementById('detail-panel'),
    detailKey: document.getElementById('detail-key'),
    detailValue: document.getElementById('detail-value'),
    detailDescription: document.getElementById('detail-description'),
    detailTags: document.getElementById('detail-tags'),
    detailStatus: document.getElementById('detail-status'),
    detailStatusInherited: document.getElementById('detail-status-inherited'),
    saveAnnotationBtn: document.getElementById('save-annotation-btn'),
    status: document.getElementById('status-bar'),
    currentFileLabel: document.getElementById('current-file-label'),
    annotatedCount: document.getElementById('annotated-count'),
    groupFilterSelect: document.getElementById('group-filter-select'),
    groupsChips: document.getElementById('groups-chips'),
    newGroupName: document.getElementById('new-group-name'),
    newGroupBtn: document.getElementById('new-group-btn'),
    detailGroups: document.getElementById('detail-groups'),
    fitViewBtn: document.getElementById('fit-view-btn'),
    graphLegend: document.getElementById('graph-legend'),
    treeFitViewBtn: document.getElementById('tree-fit-view-btn'),
  };

  const graph = window.KMapGraph.createGraph(el.graphView);
  graph.onNodeClick(async (key, isLeaf, value) => {
    await showDetail(key, isLeaf, value);
  });
  graph.setAnnotationChecker((key) => Boolean(state.annotations[key] && state.annotations[key].description));
  graph.setGroupsChecker((key) => groupsForKey(key));
  graph.setInfoProvider((key) => {
    const entry = state.entries.find((e) => e.key === key);
    const ann = state.annotations[key];
    return {
      value: entry ? entry.value : '',
      description: ann ? ann.description : '',
      tags: ann ? ann.tags : [],
    };
  });
  graph.setStatusProvider((key) => effectiveStatusForKey(key));

  const tree = window.KMapTree.createTree(el.treeView);
  tree.onNodeClick(async (key, isLeaf, value) => {
    await showDetail(key, isLeaf, value);
  });
  tree.setAnnotationChecker((key) => Boolean(state.annotations[key] && state.annotations[key].description));
  tree.setGroupsChecker((key) => groupsForKey(key));
  tree.setInfoProvider((key) => {
    const entry = state.entries.find((e) => e.key === key);
    const ann = state.annotations[key];
    return {
      value: entry ? entry.value : '',
      description: ann ? ann.description : '',
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

  function groupsForKey(key) {
    return state.groups.groups.filter((g) => g.keys.includes(key));
  }

  function setStatus(msg, isError) {
    el.status.textContent = msg;
    el.status.classList.toggle('status-error', Boolean(isError));
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
        setStatus(`No .pref files found in ${data.dir}`, true);
        return;
      }
      for (const f of data.files) {
        const opt = document.createElement('option');
        opt.value = f.path;
        opt.textContent = `${f.name} (${f.sizeBytes} bytes)`;
        el.fileSelect.appendChild(opt);
      }
      setStatus(`Found ${data.files.length} .pref file(s) in ${data.dir}`);
    } catch (err) {
      setStatus(`Could not reach server API: ${err.message}. You can still use "Upload file" below.`, true);
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
    el.currentFileLabel.textContent = label;
    setStatus(`Loaded ${state.entries.length} entries from ${label}`);
    renderTable();
    renderGraph();
    renderTree(true);
    updateAnnotatedCount();
  }

  function matchesFilter(key, value, filter) {
    if (filter) {
      const f = filter.toLowerCase();
      const ann = state.annotations[key];
      const textMatch =
        key.toLowerCase().includes(f) ||
        value.toLowerCase().includes(f) ||
        (ann && ann.description && ann.description.toLowerCase().includes(f)) ||
        (ann && ann.tags && ann.tags.some((t) => t.toLowerCase().includes(f)));
      if (!textMatch) return false;
    }
    if (state.groupFilter) {
      const group = state.groups.groups.find((g) => g.id === state.groupFilter);
      if (!group || !group.keys.includes(key)) return false;
    }
    return true;
  }

  function renderTable() {
    const filter = el.searchInput.value.trim();
    el.tableBody.innerHTML = '';

    for (const entry of state.entries) {
      if (!matchesFilter(entry.key, entry.value, filter)) continue;

      const tr = document.createElement('tr');
      tr.dataset.key = entry.key;

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
      descTd.textContent = ann && ann.description ? ann.description : '';
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

      tr.addEventListener('click', () => showDetail(entry.key, true, entry.value));

      el.tableBody.appendChild(tr);
    }
  }

  function renderGraph() {
    if (!state.tree) return;
    const { nodes, edges } = window.PrefParser.flattenTree(state.tree);
    graph.setData(nodes, edges);
    graph.setGroups(state.groups.groups);
    renderGraphLegend();
    // Give the force layout a moment to spread out before framing it.
    setTimeout(() => graph.fitToView(), 400);
  }

  function renderTree(resetView) {
    if (!state.tree) return;
    tree.setData(state.tree);
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

    addRow('<span class="graph-legend-swatch" style="background:#f2c94c"></span> Section (parent key)');
    addRow('<span class="graph-legend-swatch" style="background:#6fcf97"></span> Useful');
    addRow('<span class="graph-legend-swatch" style="background:#eb5757"></span> Not interested');
    addRow('<span class="graph-legend-swatch" style="background:#9aa1ad"></span> Field, status unset');
    addRow('<span class="graph-legend-swatch" style="background:#6fcf97;opacity:0.5"></span> Inherited from parent');
    addRow('<span class="graph-legend-swatch" style="background:transparent;border:2px solid #5aa9e6;box-sizing:border-box"></span> Has description');

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

    renderDetailGroups(key);
  }

  function updateStatusButtons() {
    for (const btn of el.detailStatus.querySelectorAll('.status-btn')) {
      btn.classList.toggle('active', btn.dataset.status === state.pendingStatus);
    }
  }

  async function setStatusForActiveKey(status) {
    if (!state.activeKey) return;
    state.pendingStatus = status;
    updateStatusButtons();
    const ann = await window.Annotations.getAnnotation(state.activeKey);
    await window.Annotations.setAnnotation(state.activeKey, { ...ann, status });
    state.annotations = await window.Annotations.loadAnnotations();
    updateInheritedNote(state.activeKey);
    renderTable();
    renderTree();
    graph.refresh();
    setStatus(
      `Marked "${state.activeKey}" as ${status || 'unset'} — subnodes without their own status inherit it.`
    );
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

  function renderDetailGroups(key) {
    el.detailGroups.innerHTML = '';
    if (state.groups.groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'detail-groups-empty';
      empty.textContent = 'No groups yet. Add one from the bar above the table.';
      el.detailGroups.appendChild(empty);
      return;
    }
    for (const g of state.groups.groups) {
      const row = document.createElement('label');
      row.className = 'detail-group-option';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = g.keys.includes(key);
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
    const current = groupsForKey(key).map((g) => g.id);
    const next = checked ? [...new Set([...current, groupId])] : current.filter((id) => id !== groupId);
    state.groups = await window.Groups.setKeyGroups(key, next);
    renderGroupsBar();
    renderTable();
    renderGraph();
    renderTree();
    setStatus(`Updated groups for "${key}"`);
  }

  async function saveCurrentAnnotation() {
    if (!state.activeKey) return;
    const description = el.detailDescription.value.trim();
    const tags = el.detailTags.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    await window.Annotations.setAnnotation(state.activeKey, { description, tags, status: state.pendingStatus });
    state.annotations = await window.Annotations.loadAnnotations();
    setStatus(`Saved annotation for "${state.activeKey}"`);
    renderTable();
    renderGraph();
    renderTree();
    updateAnnotatedCount();
  }

  function updateAnnotatedCount() {
    const total = state.entries.length;
    const annotated = state.entries.filter(
      (e) => state.annotations[e.key] && state.annotations[e.key].description
    ).length;
    el.annotatedCount.textContent = `${annotated} / ${total} annotated`;
  }

  function renderGroupsBar() {
    el.groupsChips.innerHTML = '';
    el.groupFilterSelect.innerHTML = '<option value="">All fields</option>';

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
        renderGraph();
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
    const name = el.newGroupName.value.trim();
    if (!name) {
      setStatus('Enter a group name first.', true);
      return;
    }
    const group = await window.Groups.createGroup(name);
    state.groups = await window.Groups.loadGroups();
    el.newGroupName.value = '';
    renderGroupsBar();
    setStatus(`Created group "${group.name}". Open a field's detail panel to assign it.`);
  }

  function switchView(view) {
    state.view = view;
    el.tableView.classList.toggle('hidden', view !== 'table');
    el.graphView.classList.toggle('hidden', view !== 'graph');
    el.treeView.classList.toggle('hidden', view !== 'tree');
    el.viewTableBtn.classList.toggle('active', view === 'table');
    el.viewGraphBtn.classList.toggle('active', view === 'graph');
    el.viewTreeBtn.classList.toggle('active', view === 'tree');
    if (view === 'graph') graph.resize();
    if (view === 'tree') { tree.resize(); renderTree(); }
  }

  el.scanBtn.addEventListener('click', scanFolder);
  el.loadSelectedBtn.addEventListener('click', loadSelectedFile);
  el.fileUpload.addEventListener('change', (e) => loadFromUpload(e.target.files));
  el.searchInput.addEventListener('input', renderTable);
  el.saveAnnotationBtn.addEventListener('click', saveCurrentAnnotation);
  el.viewTableBtn.addEventListener('click', () => switchView('table'));
  el.viewGraphBtn.addEventListener('click', () => switchView('graph'));
  el.viewTreeBtn.addEventListener('click', () => switchView('tree'));
  el.newGroupBtn.addEventListener('click', addNewGroup);
  el.fitViewBtn.addEventListener('click', () => graph.fitToView());
  el.treeFitViewBtn.addEventListener('click', () => tree.fitToView());
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
    await scanFolder();
  }

  init();
})();
