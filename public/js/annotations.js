/**
 * Annotation storage: descriptions/tags the user writes for each config key.
 *
 * Persistence strategy (dual, as requested):
 *   - Primary: annotations.json on disk, read/written via the PowerShell
 *     server's /api/annotations endpoint. Human-readable, portable, easy to
 *     back up or put under version control.
 *   - Mirror: browser localStorage, updated on every save and used as a
 *     fallback if the server API is unreachable (e.g. opening index.html
 *     directly as a file:// URL without the PowerShell server running).
 *
 * Shape of the annotations object:
 *   {
 *     "hi.bye.field": { "description": "...", "tags": ["tag1", "tag2"] },
 *     ...
 *   }
 */

const LOCAL_STORAGE_KEY = 'config-kmap:annotations';

let cache = null; // in-memory copy once loaded

async function loadAnnotations() {
  if (cache) return cache;

  try {
    const res = await fetch('/api/annotations', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      cache = data && typeof data === 'object' ? data : {};
      // Keep localStorage mirror in sync with the server copy.
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(cache));
      return cache;
    }
  } catch (err) {
    console.warn('Could not reach /api/annotations, falling back to localStorage.', err);
  }

  const local = localStorage.getItem(LOCAL_STORAGE_KEY);
  cache = local ? JSON.parse(local) : {};
  return cache;
}

async function saveAnnotations(all) {
  cache = all;
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(all));

  try {
    const res = await fetch('/api/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all),
    });
    if (!res.ok) {
      console.warn('Server rejected annotations save; kept localStorage copy only.');
    }
  } catch (err) {
    console.warn('Could not reach server to save annotations.json; kept localStorage copy only.', err);
  }
}

async function getAnnotation(key) {
  const all = await loadAnnotations();
  return all[key] || { description: '', tags: [] };
}

async function setAnnotation(key, annotation) {
  const all = await loadAnnotations();
  all[key] = annotation;
  await saveAnnotations(all);
  return all;
}

window.Annotations = {
  loadAnnotations,
  saveAnnotations,
  getAnnotation,
  setAnnotation,
};
