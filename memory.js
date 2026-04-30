// Persistent conversation memory — survives restarts (not redeploys on Railway)
// For true persistence across redeploys, use Upstash Redis (free tier)
import { readFileSync, writeFileSync, existsSync } from 'fs';

const MEMORY_FILE = './conversation-history.json';
const MAX_HISTORY = 40; // per channel

let store = {};

// Load from disk on startup
try {
  if (existsSync(MEMORY_FILE)) {
    store = JSON.parse(readFileSync(MEMORY_FILE, 'utf-8'));
    console.log(`Loaded ${Object.keys(store).length} conversation(s) from disk.`);
  }
} catch (err) {
  console.error('Failed to load memory file, starting fresh:', err.message);
  store = {};
}

// Save to disk (debounced)
let saveTimeout = null;
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2));
    } catch (err) {
      console.error('Failed to save memory:', err.message);
    }
  }, 2000); // save 2s after last change
}

export function getHistory(channelId) {
  if (!store[channelId]) store[channelId] = [];
  return store[channelId];
}

export function addMessage(channelId, role, content) {
  if (!store[channelId]) store[channelId] = [];
  store[channelId].push({ role, content });
  if (store[channelId].length > MAX_HISTORY) {
    store[channelId].splice(0, store[channelId].length - MAX_HISTORY);
  }
  scheduleSave();
}

export function clearHistory(channelId) {
  store[channelId] = [];
  scheduleSave();
}
