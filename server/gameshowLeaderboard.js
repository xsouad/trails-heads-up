// Global "That Won't Be Necessary" speed-round leaderboard -- shared by
// every visitor instead of being scoped to one browser's localStorage.
// Kept in memory for the life of the process and mirrored to a small JSON
// file on disk so a server restart doesn't wipe it (best-effort only --
// this is not a database, just a simple durability net).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'gameshow-leaderboard-data.json');
const MAX_ENTRIES = 50;

let entries = [];
try {
  const raw = fs.readFileSync(FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) entries = parsed;
} catch (e) {
  // No file yet (first run) or it's unreadable -- start from empty rather
  // than crash the server over a missing leaderboard file.
}

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(entries)); } catch (e) { /* best-effort only */ }
}

function addEntry(name, points, correctCount, wrongCount) {
  const entry = {
    name: (name || 'Player').toString().trim().slice(0, 24) || 'Player',
    points: Math.max(0, parseInt(points, 10) || 0),
    correctCount: Math.max(0, parseInt(correctCount, 10) || 0),
    wrongCount: Math.max(0, parseInt(wrongCount, 10) || 0),
    at: Date.now()
  };
  entries.push(entry);
  entries.sort((a, b) => (b.points - a.points) || (b.correctCount - a.correctCount));
  entries = entries.slice(0, MAX_ENTRIES);
  save();
  return entries;
}

function getEntries() {
  return entries;
}

module.exports = { addEntry, getEntries };
