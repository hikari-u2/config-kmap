/**
 * Minimal force-directed graph renderer using plain SVG + a simple
 * spring/repulsion simulation. No external dependencies (no D3/CDN),
 * since this app is meant to run fully offline from a local PowerShell
 * server.
 */

function truncate(text, max) {
  if (text == null) return '';
  const s = String(text);
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function createGraph(container) {
  container.style.position = container.style.position || 'relative';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'graph-svg');
  container.appendChild(svg);

  const edgesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  edgesGroup.setAttribute('class', 'edges');
  const nodesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
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
  let hoveredKey = null;
  // adjacency for hover highlighting: key -> Set of related keys (parent/children + group siblings)
  let adjacency = new Map();

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

    rebuildAdjacency();
    render();
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
    render();
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
      render();
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

  function statusOf(key) {
    const eff = statusForKeyFn ? statusForKeyFn(key) : null;
    if (!eff) return { status: '', inherited: false };
    const s = eff.status === 'useful' || eff.status === 'useless' ? eff.status : '';
    return { status: s, inherited: Boolean(s && eff.inherited) };
  }

  function render() {
    while (edgesGroup.firstChild) edgesGroup.removeChild(edgesGroup.firstChild);
    while (nodesGroup.firstChild) nodesGroup.removeChild(nodesGroup.firstChild);

    for (const edge of simEdges) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', edge.source.x);
      line.setAttribute('y1', edge.source.y);
      line.setAttribute('x2', edge.target.x);
      line.setAttribute('y2', edge.target.y);
      line.setAttribute('class', 'graph-edge');
      line.dataset.source = edge.source.id;
      line.dataset.target = edge.target.id;
      edgesGroup.appendChild(line);
    }

    for (const edge of groupEdges) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', edge.source.x);
      line.setAttribute('y1', edge.source.y);
      line.setAttribute('x2', edge.target.x);
      line.setAttribute('y2', edge.target.y);
      line.setAttribute('class', 'graph-edge graph-edge--group');
      line.setAttribute('stroke', edge.color || '#5aa9e6');
      line.dataset.source = edge.source.id;
      line.dataset.target = edge.target.id;
      edgesGroup.appendChild(line);
    }

    for (const n of simNodes) {
      if (n.id === '__root__') continue;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('transform', `translate(${n.x}, ${n.y})`);
      g.setAttribute('class', n.isLeaf ? 'graph-node graph-node--leaf' : 'graph-node graph-node--section');
      g.dataset.key = n.id;

      const annotated = hasAnnotationFn ? hasAnnotationFn(n.id) : false;
      if (annotated) g.classList.add('graph-node--annotated');

      const radius = n.isLeaf ? 6 : 10;

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('r', radius);
      // Status coloring: leaves are always tinted by their (effective) status,
      // sections keep the default section color until a status is set.
      // Inline style so it wins over the stylesheet's class-based fill.
      const eff = statusOf(n.id);
      if (n.isLeaf) {
        circle.style.fill = statusColor(eff.status);
      } else if (eff.status) {
        circle.style.fill = statusColor(eff.status);
      }
      if (eff.inherited) g.classList.add('graph-node--inherited');
      g.appendChild(circle);

      const memberGroups = groupsForNodeFn ? groupsForNodeFn(n.id) : [];
      memberGroups.forEach((grp, gi) => {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r', 3);
        dot.setAttribute('cx', -radius - 4 - gi * 8);
        dot.setAttribute('cy', -radius - 2);
        dot.setAttribute('fill', grp.color);
        g.appendChild(dot);
      });

      // Label: for leaves, show "parent.name = value" so the field's context
      // is readable without having to trace edges back through the graph.
      // Sections just show their own name.
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      if (n.isLeaf) {
        const parentEdge = simEdges.find((e) => e.target === n);
        const parentName = parentEdge && parentEdge.source && parentEdge.source.id !== '__root__' ? parentEdge.source.name : '';
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
      // elements (updateHoverHighlight), NOT a full render(). A full
      // render() tears down and recreates every node/edge element in the
      // SVG; if the mouse crosses several nodes' hover boundaries while
      // moving toward a click target (very likely, since hover areas are
      // adjacent), the element under the cursor can get detached from the
      // DOM between mousedown and mouseup, silently swallowing the click.
      // That looked like "clicking graph nodes does nothing." (The force
      // simulation's own per-frame render() calls are unavoidable since
      // node positions genuinely move, but at least hover no longer adds
      // to that churn.)
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

      // Allow dragging individual nodes.
      let dragging = false;
      g.addEventListener('mousedown', (e) => {
        dragging = true;
        e.stopPropagation();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const rect = svg.getBoundingClientRect();
        n.x = viewX + ((e.clientX - rect.left) / rect.width) * (width / viewScale);
        n.y = viewY + ((e.clientY - rect.top) / rect.height) * (height / viewScale);
        n.vx = 0; n.vy = 0;
        render();
      });
      window.addEventListener('mouseup', () => { dragging = false; });

      nodesGroup.appendChild(g);

      // SVG only registers clicks/hovers on painted pixels by default
      // (pointer-events: visiblePainted); the <g> itself paints nothing,
      // so gaps between the circle and its label text would fall through
      // to the background <svg> (starting a pan) instead of hitting this
      // node - which looked like clicks on graph nodes "not working".
      // Size the hit area from the label's actual rendered bounding box
      // rather than a pure estimate: in this force-directed layout nodes
      // can end up close together, and an over-generous estimated hit
      // area would overlap and block clicks on *other* nearby nodes
      // instead of just filling the gaps around this one. getBBox() can
      // still occasionally report a ~0-size box on the very first render
      // right after the text is created (before the browser has done a
      // layout pass for it), so fall back to a rough character-count
      // estimate in that case rather than leaving an unusably tiny hit
      // area stuck in place (this bit us: once the force simulation
      // settles, render() stops running, so a bad first measurement was
      // never corrected).
      const labelBox = label.getBBox();
      const estimatedWidth = String(label.textContent || '').length * 6.5;
      const labelWidth = labelBox.width > 4 ? labelBox.width : estimatedWidth;
      const labelX = labelBox.width > 4 ? labelBox.x : (n.isLeaf ? 10 : 14);
      const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      hitArea.setAttribute('x', -radius - 4);
      hitArea.setAttribute('y', -radius - 4);
      hitArea.setAttribute('width', Math.max(radius * 2 + 8, labelX + labelWidth + 4 - (-radius - 4)));
      hitArea.setAttribute('height', radius * 2 + 8);
      hitArea.setAttribute('fill', 'transparent');
      hitArea.setAttribute('class', 'graph-node-hitarea');
      g.insertBefore(hitArea, g.firstChild);
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
    setGroupsChecker(fn) { groupsForNodeFn = fn; render(); },
    setInfoProvider(fn) { infoForNodeFn = fn; },
    setStatusProvider(fn) { statusForKeyFn = fn; },
    refresh() { render(); },
    resetView() { viewX = 0; viewY = 0; viewScale = 1; applyViewBox(); },
    fitToView,
  };
}

window.KMapGraph = { createGraph };
