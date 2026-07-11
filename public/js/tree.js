/**
 * Tree view renderer: a "backbone" layout. Section keys (dotted-key path
 * segments that have children) form a vertical trunk down the middle of
 * the view, one row per node in depth-first order, with a small rightward
 * indent per depth level so nesting is still visible. Leaf fields (actual
 * key=value entries) branch horizontally off their parent section:
 *   - status "useless"  -> branch to the LEFT
 *   - status "useful"   -> branch to the RIGHT
 *   - unset             -> short branch, stays close to the trunk
 *
 * This gives an at-a-glance triage view: fields you've marked uninteresting
 * cluster on the left, fields you care about cluster on the right, and the
 * center keeps the dotted-key hierarchy readable top-to-bottom.
 */

function truncateTreeLabel(text, max) {
  if (text == null) return '';
  const s = String(text);
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function createTree(container) {
  container.style.position = container.style.position || 'relative';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tree-svg');
  container.appendChild(svg);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const arrowMarker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  arrowMarker.setAttribute('id', 'tree-callout-arrowhead');
  arrowMarker.setAttribute('viewBox', '0 0 10 10');
  arrowMarker.setAttribute('refX', '9');
  arrowMarker.setAttribute('refY', '5');
  arrowMarker.setAttribute('markerWidth', '6');
  arrowMarker.setAttribute('markerHeight', '6');
  arrowMarker.setAttribute('orient', 'auto-start-reverse');
  const arrowHead = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowHead.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  arrowMarker.appendChild(arrowHead);
  defs.appendChild(arrowMarker);

  const edgesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  edgesGroup.setAttribute('class', 'edges');
  const nodesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  nodesGroup.setAttribute('class', 'nodes');
  const calloutsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  calloutsGroup.setAttribute('class', 'tree-callouts');
  svg.appendChild(defs);
  svg.appendChild(edgesGroup);
  svg.appendChild(nodesGroup);
  svg.appendChild(calloutsGroup);

  const tooltip = document.createElement('div');
  tooltip.className = 'graph-tooltip hidden';
  container.appendChild(tooltip);

  let width = container.clientWidth || 800;
  let height = container.clientHeight || 600;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  let layoutNodes = [];
  let layoutEdges = [];
  let lastRoot = null;        // retained so collapse toggles can re-layout
  let collapsedIds = new Set(); // section ids whose children are hidden
  let onNodeClick = null;
  let hasAnnotationFn = null;
  let groupsForNodeFn = null;
  let infoForNodeFn = null;
  let statusForKeyFn = null; // (key) => { status: 'useful'|'useless'|'', inherited: bool }
  let focusUseful = false;
  let hoveredKey = null;
  let adjacency = new Map();
  let calloutBounds = [];

  // Pan/zoom state
  let viewX = 0, viewY = 0, viewScale = 1;
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let viewStart = { x: 0, y: 0 };

  function applyViewBox() {
    svg.setAttribute(
      'viewBox',
      `${viewX} ${viewY} ${width / viewScale} ${height / viewScale}`
    );
  }

  svg.addEventListener('mousedown', (e) => {
    if (e.target === svg) {
      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY };
      viewStart = { x: viewX, y: viewY };
      clearHover();
    }
  });

  /**
   * Drop any active hover highlight/tooltip. Called when a pan starts:
   * while the view is being dragged, rows sweep under the stationary
   * cursor (every 32px of vertical pan crosses one in this layout) and
   * fire mouseenter/mouseleave for each. Processing those - a full
   * highlight pass over every node and edge plus tooltip DOM writes per
   * crossing - is what made dragging the tree lag, so the hover handlers
   * ignore events during a pan and we reset the hover state once here.
   */
  function clearHover() {
    hideTooltip();
    if (hoveredKey) {
      hoveredKey = null;
      updateHoverHighlight();
    }
  }
  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    const dx = (e.clientX - panStart.x) / viewScale;
    const dy = (e.clientY - panStart.y) / viewScale;
    viewX = viewStart.x - dx;
    viewY = viewStart.y - dy;
    applyViewBox();
  });
  window.addEventListener('mouseup', () => { isPanning = false; });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = svg.getBoundingClientRect();
    const mx = viewX + ((e.clientX - rect.left) / rect.width) * (width / viewScale);
    const my = viewY + ((e.clientY - rect.top) / rect.height) * (height / viewScale);
    viewScale *= zoomFactor;
    viewScale = Math.max(0.15, Math.min(4, viewScale));
    viewX = mx - ((e.clientX - rect.left) / rect.width) * (width / viewScale);
    viewY = my - ((e.clientY - rect.top) / rect.height) * (height / viewScale);
    applyViewBox();
  }, { passive: false });

  function resize() {
    width = container.clientWidth || width;
    height = container.clientHeight || height;
    applyViewBox();
  }
  window.addEventListener('resize', resize);

  /**
   * Build the backbone layout from a hierarchical tree (same shape as
   * PrefParser.buildTree's root: { name, fullKey, children: Map, isLeaf }).
   */
  function computeLayout(root) {
    const nodes = [];
    const edges = [];

    const rowHeight = 32;
    const indentPerDepth = 18;
    const maxIndent = 140;
    const branchDist = { useful: 190, useless: 190, '': 46 };
    const centerX = width / 2;

    let rowIndex = 0;

    function statusOf(key) {
      const eff = statusForKeyFn ? statusForKeyFn(key) : null;
      if (!eff) return { status: '', inherited: false };
      const s = eff.status === 'useful' || eff.status === 'useless' ? eff.status : '';
      return { status: s, inherited: Boolean(s && eff.inherited) };
    }

    function countLeaves(node) {
      if (node.isLeaf) return 1;
      let sum = 0;
      for (const child of node.children.values()) sum += countLeaves(child);
      return sum;
    }

    function visit(node, depth, parentId) {
      const isSynthRoot = node.fullKey === '' || node.fullKey == null;
      let currentId = parentId;
      let collapsed = false;

      if (!isSynthRoot) {
        const y = rowHeight + rowIndex * rowHeight;
        rowIndex++;

        // Every node (sections included) carries a status now; sections stay
        // on the trunk but get colored, leaves branch left/right by their
        // effective (own or inherited) status.
        const eff = statusOf(node.fullKey);
        let x;
        if (node.isLeaf) {
          const dir = eff.status === 'useful' ? 1 : eff.status === 'useless' ? -1 : 0;
          const dist = branchDist[eff.status] != null ? branchDist[eff.status] : branchDist[''];
          // Branch out from the trunk position at this depth, not from
          // absolute center, so nested leaves still read as "attached" to
          // their parent section's trunk column.
          const trunkX = centerX + Math.min((depth - 1) * indentPerDepth, maxIndent);
          x = trunkX + dir * dist;
        } else {
          x = centerX + Math.min(depth * indentPerDepth, maxIndent);
        }

        collapsed = !node.isLeaf && collapsedIds.has(node.fullKey);
        nodes.push({
          id: node.fullKey,
          name: node.name,
          isLeaf: node.isLeaf,
          value: node.value,
          depth,
          x,
          y,
          status: eff.status,
          statusInherited: eff.inherited,
          collapsed,
          leafCount: node.isLeaf ? 0 : countLeaves(node),
        });
        edges.push({ source: parentId, target: node.fullKey });
        currentId = node.fullKey;
      }

      // A collapsed section still renders itself (with a leaf count) but
      // contributes no rows for its subtree.
      if (collapsed) return;

      // Rows are status-sorted at every level: Useful (green) first, unset
      // (gold) in the middle, Not interested (red) last - so the top of the
      // tree is what matters and the bottom is what's been ruled out.
      // The sort is stable, so file order is kept within each band.
      const statusRank = { useful: 0, '': 1, useless: 2 };
      const kids = [...node.children.values()].sort(
        (a, b) => statusRank[statusOf(a.fullKey).status] - statusRank[statusOf(b.fullKey).status]
      );
      for (const child of kids) {
        visit(child, depth + 1, currentId);
      }
    }

    visit(root, 0, '__root__');
    nodes.unshift({ id: '__root__', name: '', isLeaf: false, depth: 0, x: centerX, y: 8, status: null });

    return { nodes, edges };
  }

  function collectSectionIds(node, out) {
    if (!node.isLeaf && node.fullKey) out.push(node.fullKey);
    for (const child of node.children.values()) collectSectionIds(child, out);
    return out;
  }

  /**
   * The tree opens as a coverage map: every section collapsed, so the
   * first thing a returning user sees is the handful of top-level sections
   * (readable at 100%) instead of a fitted-to-nothing sliver of 250 rows.
   */
  function applyDefaultCollapse() {
    collapsedIds = new Set(lastRoot ? collectSectionIds(lastRoot, []) : []);
  }

  function relayout() {
    if (lastRoot) {
      const { nodes, edges } = computeLayout(lastRoot);
      layoutNodes = nodes;
      layoutEdges = edges;
      rebuildAdjacency();
    }
    render();
  }

  function setData(treeRoot, resetCollapsed) {
    const isFirstLoad = lastRoot === null;
    lastRoot = treeRoot;
    if (resetCollapsed || isFirstLoad) applyDefaultCollapse();
    relayout();
  }

  function toggleCollapse(id) {
    if (collapsedIds.has(id)) collapsedIds.delete(id);
    else collapsedIds.add(id);
    relayout();
  }

  function expandAll() {
    collapsedIds.clear();
    relayout();
  }

  function collapseAll() {
    applyDefaultCollapse();
    relayout();
  }

  function hasCollapsed() {
    return collapsedIds.size > 0;
  }

  function rebuildAdjacency() {
    adjacency = new Map();
    const link = (a, b) => {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a).add(b);
      adjacency.get(b).add(a);
    };
    for (const e of layoutEdges) link(e.source, e.target);
  }

  // Theme tokens rather than literal colors: these land in inline styles,
  // so nodes recolor immediately when the theme toggles.
  function statusColor(status) {
    if (status === 'useful') return 'var(--leaf)';
    if (status === 'useless') return 'var(--error)';
    return 'var(--text-dim)';
  }

  function displayStatusColor(status) {
    if (focusUseful && status === 'useless') return 'var(--dim-neutral)';
    return statusColor(status);
  }

  function wrapCalloutText(text, maxChars, maxLines) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';

    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length <= maxChars) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = word.length > maxChars ? `${word.slice(0, maxChars - 1)}\u2026` : word;
      if (lines.length === maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);

    if (lines.length === maxLines) {
      const full = words.join(' ');
      const rendered = lines.join(' ');
      if (full.length > rendered.length) {
        lines[maxLines - 1] = truncateTreeLabel(lines[maxLines - 1], maxChars);
      }
    }

    return lines.length ? lines : [''];
  }

  function render() {
    while (edgesGroup.firstChild) edgesGroup.removeChild(edgesGroup.firstChild);
    while (nodesGroup.firstChild) nodesGroup.removeChild(nodesGroup.firstChild);
    while (calloutsGroup.firstChild) calloutsGroup.removeChild(calloutsGroup.firstChild);
    calloutBounds = [];
    const pendingHitAreas = []; // { label, hitArea, radius, labelSide } for the batched measuring pass

    const idToNode = new Map(layoutNodes.map((n) => [n.id, n]));

    for (const edge of layoutEdges) {
      const source = idToNode.get(edge.source);
      const target = idToNode.get(edge.target);
      if (!source || !target) continue;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      // Right-angle-ish connector: drop from source, then across to target.
      // For section-to-section edges (both roughly on the trunk) this reads
      // as a simple vertical line; for section-to-leaf branches it reads as
      // an elbow reaching out to the left/right column.
      const midY = target.isLeaf ? target.y : (source.y + target.y) / 2;
      const d = target.isLeaf
        ? `M ${source.x} ${source.y} L ${source.x} ${target.y} L ${target.x} ${target.y}`
        : `M ${source.x} ${source.y} L ${target.x} ${midY} L ${target.x} ${target.y}`;
      path.setAttribute('d', d);
      path.setAttribute('class', target.isLeaf ? `tree-edge tree-edge--${target.status || 'unset'}` : 'tree-edge tree-edge--trunk');
      if (focusUseful && (source.status === 'useless' || target.status === 'useless')) {
        path.classList.add('tree-edge--focus-dimmed');
      }
      path.dataset.source = edge.source;
      path.dataset.target = edge.target;
      edgesGroup.appendChild(path);
    }

    for (const n of layoutNodes) {
      if (n.id === '__root__') continue;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('transform', `translate(${n.x}, ${n.y})`);
      g.setAttribute('class', n.isLeaf ? 'tree-node tree-node--leaf' : 'tree-node tree-node--section');
      g.dataset.key = n.id;

      const annotated = hasAnnotationFn ? hasAnnotationFn(n.id) : false;
      if (annotated) g.classList.add('tree-node--annotated');

      const radius = n.isLeaf ? 6 : 9;

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('r', radius);
      // Inline style so it wins over the stylesheet's class-based fill
      // (a fill *attribute* would be overridden by `.tree-node circle`).
      if (focusUseful && n.status === 'useless') g.classList.add('tree-node--focus-dimmed');
      if (n.isLeaf) {
        circle.style.fill = displayStatusColor(n.status);
      } else if (n.status) {
        circle.style.fill = displayStatusColor(n.status);
      }
      if (n.statusInherited) g.classList.add('tree-node--inherited');
      g.appendChild(circle);

      // Sections carry a +/- glyph inside the circle: the visible cue that
      // clicking them expands/collapses (it also opens the detail panel).
      if (!n.isLeaf) {
        const toggleGlyph = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        toggleGlyph.setAttribute('class', 'tree-node-toggle');
        toggleGlyph.setAttribute('text-anchor', 'middle');
        toggleGlyph.setAttribute('y', 3.5);
        toggleGlyph.textContent = n.collapsed ? '+' : '−';
        g.appendChild(toggleGlyph);
      }

      const memberGroups = groupsForNodeFn ? groupsForNodeFn(n.id) : [];
      memberGroups.forEach((grp, gi) => {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r', 3);
        dot.setAttribute('cx', 0);
        dot.setAttribute('cy', -radius - 5 - gi * 7);
        dot.setAttribute('fill', grp.color);
        g.appendChild(dot);
      });

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      const labelSide = n.isLeaf ? (n.status === 'useless' ? 'left' : 'right') : 'right';
      if (n.isLeaf) {
        label.textContent = `${truncateTreeLabel(n.name, 22)} = ${truncateTreeLabel(n.value, 16)}`;
      } else {
        // Collapsed sections show how many fields are folded away.
        label.textContent = n.collapsed ? `${n.name} (${n.leafCount})` : n.name;
      }
      // Your note rides next to the vendor's opaque name: the names are the
      // problem this tool exists to solve, so the meaning gets equal billing.
      const nodeInfo = infoForNodeFn ? infoForNodeFn(n.id) : null;
      if (nodeInfo && nodeInfo.description) {
        const desc = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        desc.setAttribute('class', 'tree-node-desc');
        desc.textContent = ` — ${truncateTreeLabel(nodeInfo.description, 34)}`;
        label.appendChild(desc);
      }
      label.setAttribute('y', 4);
      if (labelSide === 'left') {
        label.setAttribute('x', -radius - 8);
        label.setAttribute('text-anchor', 'end');
      } else {
        label.setAttribute('x', radius + 8);
        label.setAttribute('text-anchor', 'start');
      }
      g.appendChild(label);

      g.addEventListener('click', () => {
        // One click does both jobs for a section: toggle its subtree AND
        // show its details. The detail panel is a passive side panel, so
        // opening it alongside the toggle costs nothing, and it keeps
        // status-marking of sections (a core workflow) one click away.
        if (!n.isLeaf) toggleCollapse(n.id);
        if (onNodeClick) onNodeClick(n.id, n.isLeaf, n.value);
      });

      // Hovering only needs to toggle highlight classes on the existing
      // elements (updateHoverHighlight), NOT a full render(). A full
      // render() tears down and recreates every node/edge element in the
      // SVG; if the mouse crosses several nodes' hover boundaries while
      // moving toward a click target (very likely, since hover areas are
      // adjacent), the element under the cursor can get detached from the
      // DOM between mousedown and mouseup, silently swallowing the click.
      // That looked like "clicking tree nodes does nothing."
      //
      // All hover work is skipped while panning (see clearHover). The
      // mousemove handler doubles as recovery: hover state was reset when
      // the pan started, so the first move over a node afterwards
      // re-establishes its highlight.
      g.addEventListener('mouseenter', (e) => {
        if (isPanning) return;
        hoveredKey = n.id;
        updateHoverHighlight();
        showTooltip(n, e);
      });
      g.addEventListener('mousemove', (e) => {
        if (isPanning) return;
        if (hoveredKey !== n.id) {
          hoveredKey = n.id;
          updateHoverHighlight();
          showTooltip(n, e);
          return;
        }
        moveTooltip(e);
      });
      g.addEventListener('mouseleave', () => {
        if (isPanning) return;
        hoveredKey = null;
        hideTooltip();
        updateHoverHighlight();
      });

      nodesGroup.appendChild(g);

      // SVG only registers clicks/hovers on painted pixels by default
      // (pointer-events: visiblePainted); the <g> itself paints nothing,
      // so gaps between the circle and label (e.g. the space right after
      // the circle, or past the end of a short label) would fall through
      // to the background <svg> instead of triggering this node - which
      // looked like clicks on tree nodes "not working". The rect gets its
      // real geometry from the batched measuring pass after this loop.
      const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      hitArea.setAttribute('fill', 'transparent');
      hitArea.setAttribute('class', 'tree-node-hitarea');
      g.insertBefore(hitArea, g.firstChild);
      pendingHitAreas.push({ label, hitArea, radius, labelSide });
    }

    // Size hit areas from each label's actual rendered bounding box so the
    // whole row is clickable/hoverable without guessing at text width.
    // Reads (getBBox) and writes (rect attributes) run in separate passes:
    // interleaving them inside the node loop forced a synchronous reflow
    // per node, which at ~124 nodes made every render (each status click
    // re-renders the tree) cost ~124 layout passes instead of one.
    // getBBox() reports a ~0-size box while the view is hidden or before
    // the first layout pass for the text; fall back to a character-count
    // estimate in that case, since the tree only re-renders on data/status
    // changes (no continuous animation loop like the graph view) so a bad
    // first measurement here would otherwise stick permanently.
    const labelBoxes = pendingHitAreas.map((p) => p.label.getBBox());
    pendingHitAreas.forEach(({ label, hitArea, radius, labelSide }, i) => {
      const labelBox = labelBoxes[i];
      const estimatedWidth = String(label.textContent || '').length * 6.5;
      const labelWidth = labelBox.width > 4 ? labelBox.width : estimatedWidth;
      const labelX = labelBox.width > 4 ? labelBox.x : (labelSide === 'left' ? -radius - 8 - estimatedWidth : radius + 8);
      hitArea.setAttribute('x', Math.min(-radius - 4, labelX - 2));
      hitArea.setAttribute('y', -radius - 4);
      hitArea.setAttribute('width', Math.max(radius * 2 + 8, (labelX + labelWidth + 2) - Math.min(-radius - 4, labelX - 2)));
      hitArea.setAttribute('height', radius * 2 + 8);
    });

    renderFocusCallouts();
    updateHoverHighlight();
  }

  function renderFocusCallouts() {
    if (!focusUseful || !infoForNodeFn) return;

    const describedNodes = layoutNodes
      .filter((n) => n.id !== '__root__' && n.status === 'useful')
      .map((n) => ({ node: n, info: infoForNodeFn(n.id) || {} }))
      .filter(({ info }) => info.description);

    if (describedNodes.length === 0) return;

    const maxNodeX = layoutNodes
      .filter((n) => n.id !== '__root__')
      .reduce((max, n) => Math.max(max, n.x), 0);
    const noteWidth = 230;
    const lineHeight = 13;
    const padX = 10;
    const padY = 8;
    const minNoteHeight = 42;
    const noteGap = 10;
    const noteX = Math.max(maxNodeX + 150, width / 2 + 360);
    let lastNoteBottom = -Infinity;

    for (const { node, info } of describedNodes) {
      const lines = wrapCalloutText(info.description, 34, 4);
      const noteHeight = Math.max(minNoteHeight, padY * 2 + lines.length * lineHeight + 14);
      let noteY = node.y - noteHeight / 2;
      if (noteY < lastNoteBottom + noteGap) noteY = lastNoteBottom + noteGap;
      lastNoteBottom = noteY + noteHeight;

      const sourceX = node.x + (node.isLeaf ? 8 : 11);
      const sourceY = node.y;
      const targetX = noteX;
      const targetY = noteY + noteHeight / 2;

      const connector = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const midX = sourceX + (targetX - sourceX) * 0.55;
      connector.setAttribute('d', `M ${sourceX} ${sourceY} C ${midX} ${sourceY}, ${midX} ${targetY}, ${targetX - 8} ${targetY}`);
      connector.setAttribute('class', 'tree-callout-arrow');
      connector.setAttribute('marker-end', 'url(#tree-callout-arrowhead)');
      connector.dataset.source = node.id;
      connector.dataset.target = `${node.id}::note`;
      calloutsGroup.appendChild(connector);

      const note = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      note.setAttribute('class', 'tree-callout-note');
      note.setAttribute('transform', `translate(${noteX}, ${noteY})`);
      note.dataset.key = node.id;
      note.addEventListener('click', () => {
        if (onNodeClick) onNodeClick(node.id, node.isLeaf, node.value);
      });

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', noteWidth);
      rect.setAttribute('height', noteHeight);
      rect.setAttribute('rx', 6);
      note.appendChild(rect);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', padX);
      label.setAttribute('y', padY + 10);
      for (const [i, line] of lines.entries()) {
        const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        tspan.setAttribute('x', padX);
        tspan.setAttribute('dy', i === 0 ? 0 : lineHeight);
        tspan.textContent = line;
        label.appendChild(tspan);
      }
      note.appendChild(label);

      const key = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      key.setAttribute('class', 'tree-callout-key');
      key.setAttribute('x', padX);
      key.setAttribute('y', noteHeight - 7);
      key.textContent = truncateTreeLabel(node.id, 34);
      note.appendChild(key);

      calloutsGroup.appendChild(note);
      calloutBounds.push({
        minX: Math.min(sourceX, noteX),
        minY: Math.min(sourceY, noteY),
        maxX: noteX + noteWidth,
        maxY: noteY + noteHeight,
      });
    }
  }

  /**
   * Toggle focused/dimmed classes on existing node and edge elements to
   * reflect the current hoveredKey, without rebuilding the SVG DOM (see
   * the comment above the mouseenter/mouseleave handlers for why that
   * distinction matters for click reliability).
   */
  function updateHoverHighlight() {
    for (const g of nodesGroup.children) {
      const key = g.dataset.key;
      g.classList.remove('tree-node--focused', 'tree-node--dimmed');
      if (hoveredKey) {
        const related = hoveredKey === key || (adjacency.get(hoveredKey) && adjacency.get(hoveredKey).has(key));
        g.classList.add(related ? 'tree-node--focused' : 'tree-node--dimmed');
      }
    }
    for (const pathEl of edgesGroup.querySelectorAll('.tree-edge')) {
      if (!hoveredKey) { pathEl.classList.remove('tree-edge--dimmed', 'tree-edge--focused'); continue; }
      const a = pathEl.dataset.source, b = pathEl.dataset.target;
      const related = a === hoveredKey || b === hoveredKey;
      pathEl.classList.toggle('tree-edge--focused', related);
      pathEl.classList.toggle('tree-edge--dimmed', !related);
    }
    for (const noteEl of calloutsGroup.querySelectorAll('.tree-callout-note')) {
      const key = noteEl.dataset.key;
      noteEl.classList.remove('tree-callout-note--focused', 'tree-callout-note--dimmed');
      if (hoveredKey) noteEl.classList.add(hoveredKey === key ? 'tree-callout-note--focused' : 'tree-callout-note--dimmed');
    }
    for (const arrowEl of calloutsGroup.querySelectorAll('.tree-callout-arrow')) {
      if (!hoveredKey) { arrowEl.classList.remove('tree-callout-arrow--dimmed', 'tree-callout-arrow--focused'); continue; }
      const related = arrowEl.dataset.source === hoveredKey;
      arrowEl.classList.toggle('tree-callout-arrow--focused', related);
      arrowEl.classList.toggle('tree-callout-arrow--dimmed', !related);
    }
  }

  function showTooltip(n, e) {
    const info = infoForNodeFn ? infoForNodeFn(n.id) : {};
    const groupsList = groupsForNodeFn ? groupsForNodeFn(n.id) : [];

    let html = `<div class="tooltip-key">${escapeHtml(n.id)}</div>`;
    if (n.isLeaf) html += `<div class="tooltip-value">${escapeHtml(n.value)}</div>`;
    if (info && info.description) html += `<div class="tooltip-desc">${escapeHtml(info.description)}</div>`;
    if (info && info.tags && info.tags.length) html += `<div class="tooltip-tags">${info.tags.map(escapeHtml).join(', ')}</div>`;
    if (n.isLeaf || n.status) {
      const base = n.status === 'useful' ? 'Useful' : n.status === 'useless' ? 'Not interested' : 'Unset';
      const statusLabel = n.statusInherited ? `${base} (inherited)` : base;
      html += `<div class="tooltip-status tooltip-status--${n.status || 'unset'}">${statusLabel}</div>`;
    }
    if (groupsList.length) {
      html += `<div class="tooltip-groups">${groupsList.map((g) => `<span class="tooltip-group-chip" style="background:${g.color}">${escapeHtml(g.name)}</span>`).join(' ')}</div>`;
    }
    tooltip.innerHTML = html;
    tooltip.classList.remove('hidden');
    moveTooltip(e);
  }

  function moveTooltip(e) {
    const rect = container.getBoundingClientRect();
    tooltip.style.left = `${e.clientX - rect.left + 14}px`;
    tooltip.style.top = `${e.clientY - rect.top + 14}px`;
  }

  function hideTooltip() {
    tooltip.classList.add('hidden');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fitToView() {
    const real = layoutNodes.filter((n) => n.id !== '__root__');
    if (real.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of real) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    for (const b of calloutBounds) {
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    const pad = 80;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const boxW = Math.max(maxX - minX, 50);
    const boxH = Math.max(maxY - minY, 50);
    viewScale = Math.max(0.1, Math.min(4, Math.min(width / boxW, height / boxH)));
    viewX = minX + boxW / 2 - (width / viewScale) / 2;
    viewY = minY;
    applyViewBox();
  }

  /**
   * Frame the top of the tree at a readable zoom: fit the content width
   * (clamped so labels stay legible) and anchor at the first rows. Used
   * after "Expand all", where a full fitToView on 250 rows zooms out to
   * an unreadable sliver - the user pans/scrolls down instead.
   */
  function fitToTop() {
    const real = layoutNodes.filter((n) => n.id !== '__root__');
    if (real.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity;
    for (const n of real) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
    }
    // Leaf labels extend past node centers; leave room for them.
    const pad = 220;
    minX -= pad; maxX += pad;
    const boxW = Math.max(maxX - minX, 50);
    viewScale = Math.max(0.7, Math.min(1.25, width / boxW));
    viewX = minX + boxW / 2 - (width / viewScale) / 2;
    viewY = minY - 40;
    applyViewBox();
  }

  /**
   * Keep the current zoom level but move the viewport to the top of the
   * tree, centered on the content. Used after "Collapse all": the user's
   * zoom is retained, but if they were panned deep into the (now folded)
   * tree they would otherwise be left staring at empty space.
   */
  function anchorTop() {
    const real = layoutNodes.filter((n) => n.id !== '__root__');
    if (real.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity;
    for (const n of real) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
    }
    viewX = (minX + maxX) / 2 - (width / viewScale) / 2;
    viewY = minY - 40;
    applyViewBox();
  }

  return {
    setData,
    resize,
    onNodeClick(fn) { onNodeClick = fn; },
    setAnnotationChecker(fn) { hasAnnotationFn = fn; },
    setGroupsChecker(fn) { groupsForNodeFn = fn; render(); },
    setInfoProvider(fn) { infoForNodeFn = fn; },
    setStatusProvider(fn) { statusForKeyFn = fn; },
    setFocusUseful(enabled) {
      focusUseful = Boolean(enabled);
      // Focus mode presents the whole file's Useful keys and callouts;
      // collapsed sections would hide most of them, so expand first.
      if (focusUseful && collapsedIds.size > 0) collapsedIds.clear();
      relayout();
    },
    expandAll,
    collapseAll,
    hasCollapsed,
    fitToTop,
    anchorTop,
    resetView() { viewX = 0; viewY = 0; viewScale = 1; applyViewBox(); },
    fitToView,
  };
}

window.KMapTree = { createTree };
