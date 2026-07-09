/**
 * Custom groups: user-defined clusters of related keys that don't
 * necessarily share a dotted-key prefix (e.g. "Network Connection" =
 * network.proxy.host + network.proxy.port).
 *
 * Persistence mirrors annotations.js: primary copy in groups.json via the
 * PowerShell server's /api/groups endpoint, mirrored to localStorage as a
 * fallback when the server API is unreachable.
 *
 * Shape:
 *   {
 *     "groups": [
 *       { "id": "g1", "name": "Network Connection", "color": "#5aa9e6", "keys": ["network.proxy.host", "network.proxy.port"] },
 *       ...
 *     ]
 *   }
 */

const GROUPS_LOCAL_STORAGE_KEY = 'config-kmap:groups';

const PALETTE = ['#5aa9e6', '#f2994a', '#bb6bd9', '#eb5757', '#27ae60', '#f2c94c', '#56ccf2', '#9b51e0'];

let groupsCache = null;

function emptyState() {
  return { groups: [] };
}

function normalize(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.groups)) return emptyState();
  return data;
}

async function loadGroups() {
  if (groupsCache) return groupsCache;

  try {
    const res = await fetch('/api/groups', { cache: 'no-store' });
    if (res.ok) {
      const data = normalize(await res.json());
      groupsCache = data;
      localStorage.setItem(GROUPS_LOCAL_STORAGE_KEY, JSON.stringify(groupsCache));
      return groupsCache;
    }
  } catch (err) {
    console.warn('Could not reach /api/groups, falling back to localStorage.', err);
  }

  const local = localStorage.getItem(GROUPS_LOCAL_STORAGE_KEY);
  groupsCache = local ? normalize(JSON.parse(local)) : emptyState();
  return groupsCache;
}

async function saveGroups(state) {
  groupsCache = normalize(state);
  localStorage.setItem(GROUPS_LOCAL_STORAGE_KEY, JSON.stringify(groupsCache));

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(groupsCache),
    });
    if (!res.ok) {
      console.warn('Server rejected groups save; kept localStorage copy only.');
    }
  } catch (err) {
    console.warn('Could not reach server to save groups.json; kept localStorage copy only.', err);
  }
  return groupsCache;
}

function nextColor(state) {
  const used = new Set(state.groups.map((g) => g.color));
  const free = PALETTE.find((c) => !used.has(c));
  return free || PALETTE[state.groups.length % PALETTE.length];
}

async function createGroup(name) {
  const state = await loadGroups();
  const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const group = { id, name: name.trim() || 'Untitled group', color: nextColor(state), keys: [] };
  state.groups.push(group);
  await saveGroups(state);
  return group;
}

async function deleteGroup(groupId) {
  const state = await loadGroups();
  state.groups = state.groups.filter((g) => g.id !== groupId);
  await saveGroups(state);
  return state;
}

async function renameGroup(groupId, name) {
  const state = await loadGroups();
  const group = state.groups.find((g) => g.id === groupId);
  if (group) group.name = name.trim() || group.name;
  await saveGroups(state);
  return state;
}

async function setKeyGroups(key, groupIds) {
  const state = await loadGroups();
  for (const group of state.groups) {
    const has = group.keys.includes(key);
    const should = groupIds.includes(group.id);
    if (should && !has) group.keys.push(key);
    if (!should && has) group.keys = group.keys.filter((k) => k !== key);
  }
  await saveGroups(state);
  return state;
}

async function getGroupsForKey(key) {
  const state = await loadGroups();
  return state.groups.filter((g) => g.keys.includes(key));
}

window.Groups = {
  loadGroups,
  saveGroups,
  createGroup,
  deleteGroup,
  renameGroup,
  setKeyGroups,
  getGroupsForKey,
};
