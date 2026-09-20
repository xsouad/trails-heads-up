// The actual quiz board: 3 columns (Quotes / Trivia / Screenshots) x 5 rows
// ($100-$500), host-only interactive.
//
// Turn-based: each cell belongs to one team's turn (auto-alternating).
// Only that team may answer, with a 60s clock. Host reveals (for their own
// eyes only -- the quote's speaker / trivia answer / bonus screenshot never
// gets sent to non-host clients, that's a host-only judging aid, judged
// verbally) then judges. If the turn team is wrong or the clock runs out,
// the host can offer the OTHER team a one-shot steal; a wrong steal costs
// them half the cell's value.
//
// Also covers: bonus/tiebreaker questions (500 pts, host-picked team),
// letting the host reroll an unused cell's content, and replaying with a
// fresh board.

const fs = require('fs');
const path = require('path');

const QUOTES = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gameshow-quotes.json'), 'utf8'));
const TRIVIA = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gameshow-trivia.json'), 'utf8'));
const SCREENSHOTS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gameshow-screenshots.json'), 'utf8'));
const BONUS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gameshow-bonus.json'), 'utf8'));

const VALUES = [100, 200, 300, 400, 500];
const STARTING_HINTS = 3;
const COMEBACK_GAP = 1000;
const ANSWER_SECONDS = 60;

const POOLS = { quotes: QUOTES, trivia: TRIVIA, screenshots: SCREENSHOTS };

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildBoard() {
  const quotes = shuffle(QUOTES).slice(0, 5);
  const trivia = shuffle(TRIVIA).slice(0, 5);
  const screenshots = shuffle(SCREENSHOTS).slice(0, 5);

  const cells = [];
  VALUES.forEach((value, row) => {
    cells.push({ id: `quotes-${row}`, column: 'quotes', row, value, used: false, content: quotes[row] });
    cells.push({ id: `trivia-${row}`, column: 'trivia', row, value, used: false, content: trivia[row] });
    cells.push({ id: `screenshots-${row}`, column: 'screenshots', row, value, used: false, content: screenshots[row] });
  });
  return cells;
}

function initBoardState(room) {
  clearActiveTimer(room);
  room.board = buildBoard();
  room.bonusCells = {};
  room.bonusUsed = [];
  room.scores = { teamA: 0, teamB: 0 };
  room.hints = { teamA: STARTING_HINTS, teamB: STARTING_HINTS };
  room.phoneAFriend = {
    teamA: { used: false, spectatorId: null, spectatorName: null },
    teamB: { used: false, spectatorId: null, spectatorName: null }
  };
  room.activeCell = null;
  room.cellState = null;
  room.comeback = null;
  room.turnTeam = 'teamA';
}

function findCell(room, cellId) {
  return (room.board || []).find(c => c.id === cellId) || (room.bonusCells && room.bonusCells[cellId]) || null;
}

function otherTeam(team) { return team === 'teamA' ? 'teamB' : 'teamA'; }

function clearActiveTimer(room) {
  if (room._timeoutHandle) { clearTimeout(room._timeoutHandle); room._timeoutHandle = null; }
}

// ---------- host-only content ----------
// Non-host clients NEVER receive the actual answer -- the quote's speaker,
// the trivia answer, the screenshot's answer image, the bonus answer. The
// host judges verbally; these fields exist only to help the host, not to
// be displayed to competitors.
function publicCellContent(cell) {
  if (cell.column === 'quotes') return { text: cell.content.text };
  if (cell.column === 'trivia') return { question: cell.content.question };
  if (cell.column === 'screenshots') return { hint: cell.content.hint };
  if (cell.column === 'bonus') return { question: cell.content.question };
  return {};
}
function hostCellContent(cell) {
  return cell.content; // everything, including both hint+answer images for screenshots
}

function startGame(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can start the game.' };
  if (room.phase !== 'ready') return { error: 'Teams need to be locked in first.' };
  initBoardState(room);
  room.phase = 'playing';
  return { room };
}

function replayGame(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can start a new game.' };
  if (room.phase !== 'playing' && room.phase !== 'finished') return { error: 'No game to replay yet.' };
  initBoardState(room);
  room.phase = 'playing';
  return { room };
}

function rerollCell(room, socketId, cellId) {
  if (room.hostId !== socketId) return { error: 'Only the host can swap a question.' };
  const cell = findCell(room, cellId);
  if (!cell || cell.column === 'bonus') return { error: "That question doesn't exist." };
  if (cell.used) return { error: 'Already used -- nothing to swap.' };
  const pool = POOLS[cell.column];
  const usedIds = new Set(room.board.filter(c => c.column === cell.column).map(c => c.content.id));
  const candidates = pool.filter(item => !usedIds.has(item.id));
  if (!candidates.length) return { error: 'No more unused questions in that category.' };
  cell.content = candidates[Math.floor(Math.random() * candidates.length)];
  return { room };
}

function openCellInternal(room, cell, scheduleTimeout) {
  cell.used = true;
  room.activeCell = cell.id;
  const turnTeam = room.turnTeam;
  room.cellState = {
    cellId: cell.id,
    column: cell.column,
    value: cell.value,
    turnTeam,
    turnAnswer: null,
    turnLocked: false,
    timedOut: false,
    stage: 'answering', // answering -> revealed
    turnJudged: null, // null | 'correct' | 'wrong' | 'timeout'
    stealTeam: null,
    stealAnswer: null,
    stealJudged: null,
    deadline: Date.now() + ANSWER_SECONDS * 1000
  };
  if (scheduleTimeout) {
    room._timeoutHandle = setTimeout(() => {
      const cs = room.cellState;
      if (!cs || cs.cellId !== cell.id || cs.turnLocked || cs.stage !== 'answering') return;
      cs.timedOut = true;
      cs.turnJudged = 'timeout';
      scheduleTimeout(room);
    }, ANSWER_SECONDS * 1000);
  }
}

function openCell(room, socketId, cellId, scheduleTimeout) {
  if (room.hostId !== socketId) return { error: 'Only the host can open a question.' };
  if (room.phase !== 'playing') return { error: 'The game is not in progress.' };
  if (room.activeCell) return { error: 'A question is already open.' };
  const cell = findCell(room, cellId);
  if (!cell) return { error: "That question doesn't exist." };
  if (cell.used) return { error: 'That question is already used.' };
  openCellInternal(room, cell, scheduleTimeout);
  return { room };
}

function triggerBonus(room, socketId, team, scheduleTimeout) {
  if (room.hostId !== socketId) return { error: 'Only the host can trigger a bonus question.' };
  if (room.phase !== 'playing') return { error: 'The game is not in progress.' };
  if (room.activeCell) return { error: 'A question is already open.' };
  if (team !== 'teamA' && team !== 'teamB') return { error: 'Pick a team to attempt it.' };
  const available = BONUS.filter(b => !room.bonusUsed.includes(b.id));
  if (!available.length) return { error: 'No bonus questions left.' };
  const chosen = available[Math.floor(Math.random() * available.length)];
  room.bonusUsed.push(chosen.id);
  const cell = {
    id: 'bonus-' + chosen.id, column: 'bonus', row: -1, value: chosen.value, used: true,
    content: { question: chosen.question, answer: chosen.answer, by: chosen.by }
  };
  room.bonusCells[cell.id] = cell;
  room.turnTeam = team; // bonus lets the host pick who attempts it
  openCellInternal(room, cell, scheduleTimeout);
  return { room };
}

function submitAnswer(room, socketId, team, text) {
  const cs = room.cellState;
  if (!cs || cs.cellId !== room.activeCell) return { error: 'No question is open.' };
  if (cs.stage !== 'answering') return { error: 'Answers are locked in for this question.' };
  if (cs.timedOut || cs.turnLocked) return { error: "Time's up -- can't answer anymore." };
  if (team !== cs.turnTeam) return { error: "It's not your team's turn." };
  const player = room.players.get(socketId);
  if (!player || player.role !== team) return { error: 'Not on this team.' };
  const clean = (text || '').trim().slice(0, 200);
  if (!clean) return { error: 'Type an answer first.' };
  cs.turnAnswer = clean;
  cs.turnLocked = true;
  clearActiveTimer(room);
  return { room };
}

function revealAnswer(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can reveal the answer.' };
  const cs = room.cellState;
  if (!cs) return { error: 'No question is open.' };
  if (cs.stage !== 'answering') return { error: 'Already revealed.' };
  cs.stage = 'revealed';
  return { room };
}

function judgeAnswer(room, socketId, correct) {
  if (room.hostId !== socketId) return { error: 'Only the host can judge the answer.' };
  const cs = room.cellState;
  if (!cs || cs.stage !== 'revealed') return { error: 'Reveal the answer first.' };
  if (cs.timedOut) return { error: 'That team ran out of time -- nothing to judge.' };
  if (cs.turnJudged) return { error: 'Already judged.' };
  const cell = findCell(room, cs.cellId);
  cs.turnJudged = correct ? 'correct' : 'wrong';
  if (correct) {
    room.scores[cs.turnTeam] += cell.value;
  } else if (cell.column === 'bonus') {
    // Bonus rule: a wrong direct answer costs the attempting team, same as
    // a wrong steal everywhere else -- "if they don't answer correctly
    // they lose points."
    room.scores[cs.turnTeam] -= Math.floor(cell.value / 2);
  }
  return { room };
}

function openSteal(room, socketId, stealingTeam) {
  if (room.hostId !== socketId) return { error: 'Only the host can offer a steal.' };
  const cs = room.cellState;
  if (!cs || cs.stage !== 'revealed') return { error: 'Reveal the answer first.' };
  if (cs.turnJudged !== 'wrong' && cs.turnJudged !== 'timeout') {
    return { error: 'A steal only opens up after the turn team is wrong or runs out of time.' };
  }
  if (stealingTeam !== otherTeam(cs.turnTeam)) return { error: "That team wasn't waiting on this question." };
  if (cs.stealTeam) return { error: 'Steal already offered.' };
  cs.stealTeam = stealingTeam;
  cs.stealAnswer = null;
  cs.stealJudged = null;
  return { room };
}

function submitSteal(room, socketId, text) {
  const cs = room.cellState;
  if (!cs || !cs.stealTeam) return { error: 'No steal is open.' };
  if (cs.stealAnswer != null) return { error: 'Steal answer already submitted.' };
  const player = room.players.get(socketId);
  if (!player || player.role !== cs.stealTeam) return { error: 'Not on the stealing team.' };
  const clean = (text || '').trim().slice(0, 200);
  if (!clean) return { error: 'Type an answer first.' };
  cs.stealAnswer = clean;
  return { room };
}

function judgeSteal(room, socketId, correct) {
  if (room.hostId !== socketId) return { error: 'Only the host can judge the steal.' };
  const cs = room.cellState;
  if (!cs || !cs.stealTeam || cs.stealAnswer == null) return { error: 'No steal answer to judge.' };
  if (cs.stealJudged) return { error: 'Already judged.' };
  const cell = findCell(room, cs.cellId);
  cs.stealJudged = correct ? 'correct' : 'wrong';
  if (correct) {
    room.scores[cs.stealTeam] += cell.value;
  } else {
    // Failed steal costs the stealing team half the cell's value.
    room.scores[cs.stealTeam] -= Math.floor(cell.value / 2);
  }
  return { room };
}

function closeCell(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can close the question.' };
  const cs = room.cellState;
  if (!cs) return { error: 'No question is open.' };
  const canClose = cs.turnJudged === 'correct'
    || (cs.turnJudged && (!cs.stealTeam || cs.stealJudged));
  if (!canClose) return { error: 'Judge the answer (and any steal) first.' };
  clearActiveTimer(room);
  room.activeCell = null;
  room.cellState = null;
  room.turnTeam = otherTeam(room.turnTeam);
  if (room.board.every(c => c.used)) room.phase = 'finished';
  return { room };
}

function giveHint(room, socketId, team) {
  if (room.hostId !== socketId) return { error: 'Only the host can give hints.' };
  if (room.hints[team] <= 0) return { error: 'No hints left for that team.' };
  room.hints[team] -= 1;
  return { room, team };
}

function usePhoneAFriend(room, socketId, team, spectatorId) {
  if (room.hostId !== socketId) return { error: 'Only the host can use Phone a Friend.' };
  const pf = room.phoneAFriend[team];
  if (!pf) return { error: 'Unknown team.' };
  if (pf.used) return { error: 'Already used for that team.' };
  const spectator = room.players.get(spectatorId);
  if (!spectator || spectator.role !== 'spectator') return { error: 'Pick a spectator who is currently seated.' };
  pf.used = true;
  pf.spectatorId = spectator.id;
  pf.spectatorName = spectator.name;
  return { room };
}

// ---------- comeback round ("That Won't Be Necessary") ----------
// Two-stage: host triggers 'announcing' (a banner on the shared TV screen,
// giving them room to explain the rules out loud) then clicks Begin to
// actually start the clock. Everyone -- host, spectators, the other team --
// watches a live mirror of the attempt on that same shared screen while the
// chosen player gets their own focused input screen.

function startComeback(room, socketId, team, playerId) {
  if (room.hostId !== socketId) return { error: 'Only the host can start the comeback round.' };
  const gap = Math.abs(room.scores.teamA - room.scores.teamB);
  if (gap < COMEBACK_GAP) return { error: `Needs a ${COMEBACK_GAP}+ point gap to trigger.` };
  const losingTeam = room.scores.teamA < room.scores.teamB ? 'teamA' : 'teamB';
  if (team !== losingTeam) return { error: 'Only the team that is behind can attempt the comeback round.' };
  const player = room.players.get(playerId);
  if (!player || player.role !== team) return { error: 'Pick a player on that team.' };
  room.comeback = {
    team, playerId, playerName: player.name,
    stage: 'announcing', // announcing -> active -> done
    points: 0, live: null
  };
  return { room };
}

function beginComeback(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can begin the round.' };
  const cb = room.comeback;
  if (!cb || cb.stage !== 'announcing') return { error: 'No comeback round waiting to begin.' };
  cb.stage = 'active';
  cb.live = { points: 0, correctCount: 0, img: null };
  return { room };
}

function updateComebackLive(room, socketId, live) {
  const cb = room.comeback;
  if (!cb || cb.stage !== 'active' || cb.playerId !== socketId) return { error: 'No active comeback round for you.' };
  cb.live = {
    points: Math.max(0, parseInt(live.points, 10) || 0),
    correctCount: Math.max(0, parseInt(live.correctCount, 10) || 0),
    img: live.img || null
  };
  return { room };
}

function finishComeback(room, socketId, points) {
  const cb = room.comeback;
  if (!cb || cb.stage !== 'active') return { error: 'No comeback round in progress.' };
  if (socketId !== cb.playerId) return { error: 'Only the player attempting it can finish it.' };
  const earned = Math.max(0, parseInt(points, 10) || 0);
  room.scores[cb.team] += earned;
  room.comeback = { ...cb, stage: 'done', points: earned, live: null };
  return { room };
}

function clearComebackBanner(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can dismiss this.' };
  room.comeback = null;
  return { room };
}

// ---------- serialization ----------
function serializeBoard(room, forHost) {
  if (!room.board) return null;
  const activeCell = room.activeCell ? findCell(room, room.activeCell) : null;
  const cs = room.cellState;
  return {
    cells: room.board.map(c => ({
      id: c.id, column: c.column, row: c.row, value: c.value, used: c.used
    })),
    scores: room.scores,
    hints: room.hints,
    phoneAFriend: room.phoneAFriend,
    comeback: room.comeback,
    turnTeam: room.turnTeam,
    bonusRemaining: BONUS.length - room.bonusUsed.length,
    active: activeCell && cs ? {
      cellId: cs.cellId,
      column: activeCell.column,
      value: activeCell.value,
      turnTeam: cs.turnTeam,
      stage: cs.stage,
      deadline: cs.deadline,
      content: forHost ? hostCellContent(activeCell) : publicCellContent(activeCell),
      turnAnswer: forHost || cs.turnLocked ? cs.turnAnswer : null,
      turnLocked: cs.turnLocked,
      timedOut: cs.timedOut,
      turnJudged: cs.turnJudged,
      stealTeam: cs.stealTeam,
      stealAnswer: cs.stealAnswer,
      stealJudged: cs.stealJudged
    } : null
  };
}

module.exports = {
  startGame, replayGame, rerollCell, openCell, triggerBonus,
  submitAnswer, revealAnswer, judgeAnswer,
  openSteal, submitSteal, judgeSteal, closeCell, giveHint, usePhoneAFriend,
  startComeback, beginComeback, updateComebackLive, finishComeback, clearComebackBanner,
  serializeBoard, COMEBACK_GAP, STARTING_HINTS, ANSWER_SECONDS
};
