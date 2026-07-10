/**
 * Minimal force-directed graph renderer using plain SVG + a simple
 * spring/repulsion simulation. No external dependencies (no D3/CDN),
 * since this app is meant to run fully offline from a local PowerShell
 * server.
 *
 * Rendering is split into three phases so the per-frame cost during the
 * force simulation stays tiny:
 *   - buildScene():      creates SVG elements + listeners, once per data or
 *                        group-structure change.
 *   - updatePositions(): only writes transforms / line endpoints on the
 *                        existing elements; runs every simulation frame and
 *                        while dragging a node.
 *   - refreshStyles():   recolors / re-dims the existing elements when
 *                        statuses, annotations, or focus mode change - no
 *                        DOM rebuild at all.
 * An earlier version rebuilt the entire SVG every simulation frame and
 * registered fresh window-level drag listeners for every node on every
 * rebuild. With ~300 sim frames per layout that accumulated tens of
 * thousands of permanent mousemove listeners (and pinned every discarded
 * DOM tree in memory via their closures), which made the whole app -
 * zooming, clicking, editing - progressively slower the longer it ran.
 */

const GRAPH_SVG_NS = 'http://www.w3.org/2000/svg';

function truncate(text, max) {
  if (text == null) return '';
  const s = String(text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function createGraph(container) {
  container.style.position = container.style.position || 'relative';

  const svg = document.createElementNS(GRAPH_SVG_NS, 'svg');
  svg.setAttribute('class', 'graph-svg');
  container.appendChild(svg);

  const edgesGroup = document.createElementNS(GRAPH_SVG_NS, 'g');
  edgesGroup.setAttribute('class', 'edges');
  const nodesGroup = document.createElementNS(GRAPH_SVG_NS, 'g');
  nodesGroup.setAttribute('class', 'nodes');
  svg.appendChild(edgesGroup);
  svg.appendChild(nodesGroup);

  const tooltip = document.createElement('div');
  tooltip.className = 'graph-tooltip hidden';
  container.appendChild(tooltip);

  let width = container.clientWidth || 800;
  let height = container.clientHeight || 600;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  let simNodes = [];
  let simEdges = [];
  let groupEdges = [];
  let rafId = null;
  let onNodeClick = null;
  let hasAnnotationFn = null;
  let groupsForNodeFn = null; // (key) => [{ id, color, name }, ...]
  let infoForNodeFn = null;   // (key) => { value, description, tags: [] }
  let statusForKeyFn = null;  // (key) => { status: 'useful'|'useless'|'', inherited: bool }
  let focusUseful = false;
  let hoveredKey = null;
  // adjacency for hover highlighting: key -> Set of related keys (parent/children + group siblings)
  let adjacency = new Map();

  // Scene element registry, rebuilt by buildScene() and updated in place by
  // updatePositions() / refreshStyles() between rebuilds.
  let nodeEls = new Map(); // node.id -> { node, g, circle, label, hitArea, radius }
  let edgeEls = [];        // { edge, line } for tree edges + group edges
  let parentNameById = new Map(); // node id -> parent section name, for leaf labels
  let hitAreasMeasured = false;

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
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    const dx = (e.clientX - panStart.x) / viewScale;
    const dy = (e.clientY - panStart.y) / viewScale;
    viewX = viewStart.x - dx;
    viewY = viewStart.y - dy;
    applyViewBox();
  });
  window.addEventListener('mouseup', () => { isPanning = false; });

  // One window-level listener pair handles dragging for ALL nodes; each
  // node's mousedown just records itself as the drag target. (These used
  // to be registered per node inside the render loop, which is where the
  // listener leak described in the header comment came from.)
  let draggedNode = null;
  window.addEventListener('mousemove', (e) => {
    if (!draggedNode) return;
    const rect = svg.getBoundingClientRect();
    draggedNode.x = viewX + ((e.clientX - rect.left) / rect.width) * (width / viewScale);
    draggedNode.y = viewY + ((e.clientY - rect.top) / rect.height) * (height / viewScale);
    draggedNode.vx = 0;
    draggedNode.vy = 0;
    updatePositions();
  });
  window.addEventListener('mouseup', () => { draggedNode = null; });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = svg.getBoundingClientRect();
    const mx = viewX + ((e.clientX - rect.left) / rect.width) * (width / viewScale);
    const my = viewY + ((e.clientY - rect.top) / rect.height) * (height / viewScale);
    viewScale *= zoomFactor;
    viewScale = Math.max(0.15, Math.min(4, viewScale));
    // keep mouse position stable while zooming
    viewX = mx - ((e.clientX - rect.left) / rect.width) * (width / viewScale);
    viewY = my - ((e.clientY - rect.top) / rect.height) * (height / viewScale);
    applyViewBox();
  }, { passive: false });

  function resize() {
    width = container.clientWidth || width;
    height = container.clientHeight || height;
    applyViewBox();
    // The scene may have been built while this view was hidden
    // (display:none), where getBBox() reports zero-size boxes and the hit
    // areas fall back to estimates. Re-measure once the view is actually
    // shown so hit areas match the real rendered labels.
    if (!hitAreasMeasured && nodeEls.size) measureHitAreas();
  }
  window.addEventListener('resize', resize);

  function setData(nodes, edges) {
    // nodes: [{ fullKey, name, isLeaf, value }]
    // edges: [{ source, target }]
    const idToNode = new Map();

    // Spread initial positions further apart for large datasets so the
    // force simulation has room to breathe and doesn't start fully collapsed.
    const spreadRadius = Math.max(Math.min(width, height) / 2.4, 40 + nodes.length * 6);

    simNodes = nodes.map((n, i) => {
      const angle = (i / nodes.length) * Math.PI * 2;
      const node = {
        id: n.fullKey,
        name: n.name,
        isLeaf: n.isLeaf,
        value: n.value,
        x: width / 2 + Math.cos(angle) * spreadRadius + (Math.random() - 0.5) * 20,
        y: height / 2 + Math.sin(angle) * spreadRadius + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
      };
      idToNode.set(n.fullKey, node);
      return node;
    });
    idToNode.set('__root__', { id: '__root__', x: width / 2, y: height / 2, vx: 0, vy: 0, fixed: true, name: '', isLeaf: false });

    simEdges = edges
      .map((e) => ({ source: idToNode.get(e.source), target: idToNode.get(e.target) }))
      .filter((e) => e.source && e.target);

    // Include root as a visible small anchor node too, so the graph doesn't fly apart.
    if (!simNodes.find((n) => n.id === '__root__')) {
      simNodes.unshift(idToNode.get('__root__'));
    }

    // Leaf labels show "parent.name = value"; resolve each node's parent
    // once here instead of scanning simEdges per label on every rebuild.
    parentNameById = new Map();
    for (const e of simEdges) {
      if (e.source.id !== '__root__') parentNameById.set(e.target.id, e.source.name);
    }

    rebuildAdjacency();
    buildScene();
    startSimulation();
  }

  function rebuildAdjacency() {
    adjacency = new Map();
    const link = (a, b) => {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a).add(b);
      adjacency.get(b).add(a);
    };
    for (const e of simEdges) link(e.source.id, e.target.id);
    for (const e of groupEdges) link(e.source.id, e.target.id);
  }

  /**
   * Recompute cross-cutting group edges (pairs of nodes sharing a group)
   * from the current node set + the groups list, and restart the sim so
   * grouped nodes pull toward each other regardless of tree distance.
   * Node positions and the current pan/zoom are preserved - only the group
   * links (and their spring forces) change.
   * groups: [{ id, color, name, keys: [fullKey,...] }, ...]
   */
  function setGroups(groups) {
    const idToNode = new Map(simNodes.map((n) => [n.id, n]));
    const edges = [];
    for (const group of groups || []) {
      const members = (group.keys || []).map((k) => idToNode.get(k)).filter(Boolean);
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          edges.push({ source: members[i], target: members[j], color: group.color });
        }
      }
    }
    groupEdges = edges;
    rebuildAdjacency();
    buildScene();
    startSimulation();
  }

  function startSimulation() {
    if (rafId) cancelAnimationFrame(rafId);
    let iterations = 0;
    const maxIterations = 300;
    // Nodes typically settle (velocities near zero) well before
    // maxIterations. Running the full 300 frames regardless meant clicks
    // could target where a node *used to be* a moment ago - by the time a
    // real mouse click's mousedown/mouseup land, the still-moving node
    // had already drifted elsewhere, and the click just hit empty
    // background instead (harder to notice on the very first click right
    // after loading, since a lucky low-movement frame can still line up;
    // much more apparent on the next click). Stopping as soon as the
    // layout is visually settled avoids that mismatch.
    const settleThreshold = 0.05;

    function tick() {
      step();
      updatePositions();
      iterations++;
      let totalSpeedSq = 0;
      for (const n of simNodes) {
        if (n.fixed) continue;
        totalSpeedSq += n.vx * n.vx + n.vy * n.vy;
      }
      const settled = totalSpeedSq / Math.max(simNodes.length, 1) < settleThreshold;
      if (iterations < maxIterations && !settled) {
        rafId = requestAnimationFrame(tick);
      }
    }
    tick();
  }

  function step() {
    const repulsion = 4200;
    const springLength = 100;
    const springStrength = 0.02;
    const damping = 0.85;
    const centerPull = 0.002;

    for (let i = 0; i < simNodes.length; i++) {
      const a = simNodes[i];
      if (a.fixed) continue;
      let fx = 0, fy = 0;

      for (let j = 0; j < simNodes.length; j++) {
        if (i === j) continue;
        const b = simNodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) distSq = 1;
        const dist = Math.sqrt(distSq);
        const force = repulsion / distSq;
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      }

      // gentle pull toward center to keep graph from drifting away
      fx += (width / 2 - a.x) * centerPull;
      fy += (height / 2 - a.y) * centerPull;

      a.vx = (a.vx + fx) * damping;
      a.vy = (a.vy + fy) * damping;
    }

    for (const edge of simEdges) {
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const diff = dist - springLength;
      const fx = (dx / dist) * diff * springStrength;
      const fy = (dy / dist) * diff * springStrength;
      if (!edge.source.fixed) { edge.source.vx += fx; edge.source.vy += fy; }
      if (!edge.target.fixed) { edge.target.vx -= fx; edge.target.vy -= fy; }
    }

    // Group membership pulls unrelated nodes closer together, similar to a
    // tree edge but usually longer since grouped fields can live far apart
    // in the key hierarchy.
    const groupSpringLength = 110;
    const groupSpringStrength = 0.01;
    for (const edge of groupEdges) {
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const diff = dist - groupSpringLength;
      const fx = (dx / dist) * diff * groupSpringStrength;
      const fy = (dy / dist) * diff * groupSpringStrength;
      if (!edge.source.fixed) { edge.source.vx += fx; edge.source.vy += fy; }
      if (!edge.target.fixed) { edge.target.vx -= fx; edge.target.vy -= fy; }
    }

    for (const n of simNodes) {
      if (n.fixed) continue;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  function statusColor(status) {
    if (status === 'useful') return '#6fcf97';
    if (status === 'useless') return '#eb5757';
    return '#9aa1ad';
  }

  function displayStatusColor(status) {
    if (focusUseful && status === 'useless') return '#555b66';
    return statusColor(status);
  }

  function statusOf(key) {
    const eff = statusForKeyFn ? statusForKeyFn(key) : null;
    if (!eff) return { status: '', inherited: false };
    const s = eff.status === 'useful' || eff.status === 'useless' ? eff.status : '';
    return { status: s, inherited: Boolean(s && eff.inherited) };
  }

  /**
   * Create the SVG elements for the current node/edge sets. Called once per
   * data or group change - NOT per simulation frame. Positions and status
   * styling are applied by updatePositions()/refreshStyles() afterwards.
   */
  function buildScene() {
    while (edgesGroup.firstChild) edgesGroup.removeChild(edgesGroup.firstChild);
    while (nodesGroup.firstChild) nodesGroup.removeChild(nodesGroup.firstChild);
    nodeEls = new Map();
    edgeEls = [];

    for (const edge of simEdges) {
      const line = document.createElementNS(GRAPH_SVG_NS, 'line');
      line.setAttribute('class', 'graph-edge');
      line.dataset.source = edge.source.id;
      line.dataset.target = edge.target.id;
      edgesGroup.appendChild(line);
      edgeEls.push({ edge, line });
    }

    for (const edge of groupEdges) {
      const line = document.createElementNS(GRAPH_SVG_NS, 'line');
      line.setAttribute('class', 'graph-edge graph-edge--group');
      line.setAttribute('stroke', edge.color || '#5aa9e6');
      line.dataset.source = edge.source.id;
      line.dataset.target = edge.target.id;
      edgesGroup.appendChild(line);
      edgeEls.push({ edge, line });
    }

    for (const n of simNodes) {
      if (n.id === '__root__') continue;
      const g = document.createElementNS(GRAPH_SVG_NS, 'g');
      g.setAttribute('class', n.isLeaf ? 'graph-node graph-node--leaf' : 'graph-node graph-node--section');
      g.dataset.key = n.id;

      const radius = n.isLeaf ? 6 : 10;

      const circle = document.createElementNS(GRAPH_SVG_NS, 'circle');
      circle.setAttribute('r', radius);
      g.appendChild(circle);

      const memberGroups = groupsForNodeFn ? groupsForNodeFn(n.id) : [];
      memberGroups.forEach((grp, gi) => {
        const dot = document.createElementNS(GRAPH_SVG_NS, 'circle');
        dot.setAttribute('r', 3);
        dot.setAttribute('cx', -radius - 4 - gi * 8);
        dot.setAttribute('cy', -radius - 2);
        dot.setAttribute('fill', grp.color);
        g.appendChild(dot);
      });

      // Label: for leaves, show "parent.name = value" so the field's context
      // is readable without having to trace edges back through the graph.
      // Sections just show their own name.
      const label = document.createElementNS(GRAPH_SVG_NS, 'text');
      if (n.isLeaf) {
        const parentName = parentNameById.get(n.id) || '';
        const context = parentName ? `${parentName}.${n.name}` : n.name;
        label.textContent = `${truncate(context, 26)} = ${truncate(n.value, 16)}`;
      } else {
        label.textContent = n.name;
      }
      label.setAttribute('x', n.isLeaf ? 10 : 14);
      label.setAttribute('y', 4);
      g.appendChild(label);

      g.addEventListener('click', () => {
        if (onNodeClick) onNodeClick(n.id, n.isLeaf, n.value);
      });

      // Hovering only needs to toggle highlight classes on the existing
      // elements (updateHoverHighlight), NOT a rebuild. A rebuild tears
      // down and recreates every node/edge element in the SVG; if the
      // mouse crosses several nodes' hover boundaries while moving toward
      // a click target (very likely, since hover areas are adjacent), the
      // element under the cursor can get detached from the DOM between
      // mousedown and mouseup, silently swallowing the click. That looked
      // like "clicking graph nodes does nothing."
      g.addEventListener('mouseenter', (e) => {
        hoveredKey = n.id;
        updateHoverHighlight();
        showTooltip(n, e);
      });
      g.addEventListener('mousemove', (e) => moveTooltip(e));
      g.addEventListener('mouseleave', () => {
        hoveredKey = null;
        hideTooltip();
        updateHoverHighlight();
      });

      // Dragging: just claim the shared window-level drag handler (see the
      // listener setup near the pan/zoom handlers above).
      g.addEventListener('mousedown', (e) => {
        draggedNode = n;
        e.stopPropagation();
      });

      // SVG only registers clicks/hovers on painted pixels by default
      // (pointer-events: visiblePainted); the <g> itself paints nothing,
      // so gaps between the circle and its label text would fall through
      // to the background <svg> (starting a pan) instead of hitting this
      // node - which looked like clicks on graph nodes "not working".
      // The rect is created here with placeholder geometry; its real size
      // comes from measureHitAreas() below, which batches the label
      // measurements so the browser doesn't reflow once per node.
      const hitArea = document.createElementNS(GRAPH_SVG_NS, 'rect');
      hitArea.setAttribute('fill', 'transparent');
      hitArea.setAttribute('class', 'graph-node-hitarea');
      g.insertBefore(hitArea, g.firstChild);

      nodesGroup.appendChild(g);
      nodeEls.set(n.id, { node: n, g, circle, label, hitArea, radius });
    }

    updatePositions();
    refreshStyles();
    measureHitAreas();
  }

  /**
   * Size each node's hit area from its label's actual rendered bounding
   * box. In this force-directed layout nodes can end up close together,
   * and an over-generous estimated hit area would overlap and block clicks
   * on *other* nearby nodes instead of just filling the gaps around this
   * one. Reads (getBBox) and writes (rect attributes) are done in separate
   * passes: interleaving them forces a synchronous reflow per node, which
   * at ~124 nodes made every rebuild cost ~124 layout passes.
   *
   * getBBox() reports a ~0-size box when the view is hidden (display:none)
   * or before the first layout pass for the text; fall back to a rough
   * character-count estimate then, and let resize() re-measure once the
   * view is actually visible so a bad measurement doesn't stick.
   */
  function measureHitAreas() {
    const entries = [...nodeEls.values()];
    const boxes = entries.map(({ label }) => label.getBBox());

    let anyReal = false;
    entries.forEach(({ node, label, hitArea, radius }, i) => {
      const box = boxes[i];
      if (box.width > 4) anyReal = true;
      const estimatedWidth = String(label.textContent || '').length * 6.5;
      const labelWidth = box.width > 4 ? box.width : estimatedWidth;
      const labelX = box.width > 4 ? box.x : (node.isLeaf ? 10 : 14);
      hitArea.setAttribute('x', -radius - 4);
      hitArea.setAttribute('y', -radius - 4);
      hitArea.setAttribute('width', Math.max(radius * 2 + 8, labelX + labelWidth + 4 - (-radius - 4)));
      hitArea.setAttribute('height', radius * 2 + 8);
    });
    hitAreasMeasured = anyReal || entries.length === 0;
  }

  /**
   * Write current simulation coordinates onto the existing elements.
   * This is the only work done per simulation frame.
   */
  function updatePositions() {
    for (const { edge, line } of edgeEls) {
      line.setAttribute('x1', edge.source.x);
      line.setAttribute('y1', edge.source.y);
      line.setAttribute('x2', edge.target.x);
      line.setAttribute('y2', edge.target.y);
    }
    for (const { node, g } of nodeEls.values()) {
      g.setAttribute('transform', `translate(${node.x}, ${node.y})`);
    }
  }

  /**
   * Re-apply status colors, annotation rings, inherited markers, and focus
   * dimming to the existing elements. Called after annotation/status/focus
   * changes - much cheaper than rebuilding the scene, and it leaves node
   * positions and the current pan/zoom untouched.
   */
  function refreshStyles() {
    for (const { node, g, circle } of nodeEls.values()) {
      const eff = statusOf(node.id);
      g.classList.toggle('graph-node--annotated', Boolean(hasAnnotationFn && hasAnnotationFn(node.id)));
      g.classList.toggle('graph-node--inherited', eff.inherited);
      g.classList.toggle('graph-node--focus-dimmed', focusUseful && eff.status === 'useless');
      // Status coloring: leaves are always tinted by their (effective) status,
      // sections keep the default section color until a status is set.
      // Inline style so it wins over the stylesheet's class-based fill.
      if (node.isLeaf || eff.status) {
        circle.style.fill = displayStatusColor(eff.status);
      } else {
        circle.style.fill = '';
      }
    }
    for (const { edge, line } of edgeEls) {
      const dimmed = focusUseful &&
        (statusOf(edge.source.id).status === 'useless' || statusOf(edge.target.id).status === 'useless');
      line.classList.toggle('graph-edge--focus-dimmed', dimmed);
    }
    updateHoverHighlight();
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
      g.classList.remove('graph-node--focused', 'graph-node--dimmed');
      if (hoveredKey) {
        const related = hoveredKey === key || (adjacency.get(hoveredKey) && adjacency.get(hoveredKey).has(key));
        g.classList.add(related ? 'graph-node--focused' : 'graph-node--dimmed');
      }
    }
    for (const lineEl of edgesGroup.querySelectorAll('.graph-edge')) {
      if (!hoveredKey) { lineEl.classList.remove('graph-edge--dimmed', 'graph-edge--focused'); continue; }
      const a = lineEl.dataset.source, b = lineEl.dataset.target;
      const related = a === hoveredKey || b === hoveredKey;
      lineEl.classList.toggle('graph-edge--focused', related);
      lineEl.classList.toggle('graph-edge--dimmed', !related);
    }
  }

  function showTooltip(n, e) {
    const info = infoForNodeFn ? infoForNodeFn(n.id) : {};
    const groupsList = groupsForNodeFn ? groupsForNodeFn(n.id) : [];

    let html = `<div class="tooltip-key">${escapeHtml(n.id)}</div>`;
    if (n.isLeaf) html += `<div class="tooltip-value">${escapeHtml(n.value)}</div>`;
    if (info && info.description) html += `<div class="tooltip-desc">${escapeHtml(info.description)}</div>`;
    if (info && info.tags && info.tags.length) html += `<div class="tooltip-tags">${info.tags.map(escapeHtml).join(', ')}</div>`;
    const eff = statusOf(n.id);
    if (n.isLeaf || eff.status) {
      const base = eff.status === 'useful' ? 'Useful' : eff.status === 'useless' ? 'Not interested' : 'Unset';
      const statusLabel = eff.inherited ? `${base} (inherited)` : base;
      html += `<div class="tooltip-status tooltip-status--${eff.status || 'unset'}">${statusLabel}</div>`;
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

  /**
   * Zoom/pan so all current nodes fit within the viewport, with padding.
   * Useful after loading a new file or resizing, since the force layout's
   * extent isn't known in advance.
   */
  function fitToView() {
    const real = simNodes.filter((n) => n.id !== '__root__');
    if (real.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of real) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    const pad = 60;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const boxW = Math.max(maxX - minX, 50);
    const boxH = Math.max(maxY - minY, 50);
    viewScale = Math.max(0.15, Math.min(4, Math.min(width / boxW, height / boxH)));
    viewX = minX + boxW / 2 - (width / viewScale) / 2;
    viewY = minY + boxH / 2 - (height / viewScale) / 2;
    applyViewBox();
  }

  return {
    setData,
    setGroups,
    resize,
    onNodeClick(fn) { onNodeClick = fn; },
    setAnnotationChecker(fn) { hasAnnotationFn = fn; },
    setGroupsChecker(fn) { groupsForNodeFn = fn; buildScene(); },
    setInfoProvider(fn) { infoForNodeFn = fn; },
    setStatusProvider(fn) { statusForKeyFn = fn; },
    setFocusUseful(enabled) { focusUseful = Boolean(enabled); refreshStyles(); },
    refresh() { refreshStyles(); },
    resetView() { viewX = 0; viewY = 0; viewScale = 1; applyViewBox(); },
    fitToView,
  };
}

window.KMapGraph = { createGraph };
