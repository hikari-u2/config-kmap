/**
 * Parser for dotted key=value ".pref" config files, e.g.:
 *
 *   hi.bye.field=10
 *   ui.window.width=1024
 *   # comment
 *
 * Produces both a flat list of entries and a hierarchical tree, so the UI
 * can render a searchable table as well as a node graph.
 */

/**
 * Parse raw .pref text into a flat array of { key, value, path[] } entries.
 * Blank lines and lines starting with # or ; are ignored.
 * The first '=' on a line separates key from value; '=' inside the value is kept.
 */
function parsePrefText(text) {
  const entries = [];
  const lines = text.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#') || line.startsWith(';')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue; // skip malformed lines silently

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (key.length === 0) continue;

    entries.push({
      key,
      value,
      path: key.split('.'),
      line: i + 1,
    });
  }

  return entries;
}

/**
 * Build a hierarchical tree from flat entries, keyed by dotted path segments.
 * Each node: { name, fullKey, children: Map, value?, isLeaf }
 */
function buildTree(entries) {
  const root = { name: '', fullKey: '', children: new Map(), isLeaf: false };

  for (const entry of entries) {
    let node = root;
    let prefix = '';
    for (let i = 0; i < entry.path.length; i++) {
      const segment = entry.path[i];
      prefix = prefix ? `${prefix}.${segment}` : segment;
      if (!node.children.has(segment)) {
        node.children.set(segment, {
          name: segment,
          fullKey: prefix,
          children: new Map(),
          isLeaf: false,
        });
      }
      node = node.children.get(segment);
    }
    node.isLeaf = true;
    node.value = entry.value;
    node.line = entry.line;
  }

  return root;
}

/**
 * Flatten the tree back into a list of all nodes (including intermediate
 * "section" nodes), useful for building graph nodes/edges.
 */
function flattenTree(root) {
  const nodes = [];
  const edges = [];

  function visit(node, parent) {
    if (node !== root) {
      nodes.push(node);
      if (parent && parent !== root) {
        edges.push({ source: parent.fullKey, target: node.fullKey });
      } else if (parent === root) {
        edges.push({ source: '__root__', target: node.fullKey });
      }
    }
    for (const child of node.children.values()) {
      visit(child, node);
    }
  }

  visit(root, null);
  return { nodes, edges };
}

// Exposed as globals for simple <script> usage (no bundler).
window.PrefParser = {
  parsePrefText,
  buildTree,
  flattenTree,
};
