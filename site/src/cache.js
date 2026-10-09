export function readStorage(key, fallback = null) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
export function writeStorage(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
export function saveCache(key, data) { writeStorage(key,{savedAt:Date.now(),data}); }
export function loadCache(key, maxAge = 30*60_000) {
  const saved = readStorage(key);
  return saved?.data && Number.isFinite(saved.savedAt) && Date.now()-saved.savedAt >= 0 && Date.now()-saved.savedAt <= maxAge ? saved : null;
}
