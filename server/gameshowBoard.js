// The actual quiz board: 3 columns (Quotes / Trivia / Screenshots) x 5 rows
// ($100-$500), host-only interactive. Host opens a cell, both teams submit
// one answer each, host reveals the real answer and judges by hand (no
// brittle text-matching -- same "host has final say" pattern as team
// naming). A team judged wrong can be offered a Steal by the host; a wrong
// steal earns the original team a bonus hint, per spec.
//
// Bonus/tie-breaker trivia questions are intentionally NOT wired in here --
// noted for later, not implemented, per the user's own instruction.

const fs = require('fs');
const path = require('path');

const QUOTES = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gameshow-quotes.json'), 'utf8'));
const TRIVIA = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gameshow-trivia.json'), 'utf8'));
const SCREENSHOTS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/gameshow-screenshots.json'), 'utf8'));

const VALUES = [100, 200, 300, 400, 500];
const STARTING_HINTS = 3;
const COMEBACK_GAP = 10;

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

// Board state lives on the room object created in gameshowRooms.js; these
// functions just read/write fields on it (initBoardState called once when
// the host starts the game).
function initBoardState(room) {
  room.board = buildBoard();
  room.scores = { teamA: 0, teamB: 0 };
  room.hints = { teamA: STARTING_HINTS, teamB: STARTING_HINTS };
  room.phoneAFriend = {
    teamA: { used: false, spectatorId: null, spectatorName: null },
    teamB: { used: false, spectatorId: null, spectatorName: null }
  };
  room.activeCell = null;
  room.cellState = null;
  room.comeback = null;
}

function findCell(room, cellId) {
  return (room.board || []).find(c => c.id === cellId) || null;
}

// What a non-host viewer is allowed to see before the answer is revealed --
// the prompt itself, never the answer field(s).
function publicCellContent(cell, revealed) {
  if (revealed) return cell.content;
  if (cell.column === 'quotes') return { text: cell.content.text, game: cell.content.game };
  if (cell.column === 'trivia') return { question: cell.content.question };
  if (cell.column === 'screenshots') return { hint: cell.content.hint };
  return {};
}

function otherTeam(team) { return team === 'teamA' ? 'teamB' : 'teamA'; }

function startGame(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can start the game.' };
  if (room.phase !== 'ready') return { error: 'Teams need to be locked in first.' };
  initBoardState(room);
  room.phase = 'playing';
  return { room };
}

function openCell(room, socketId, cellId) {
  if (room.hostId !== socketId) return { error: 'Only the host can open a question.' };
  if (room.phase !== 'playing') return { error: 'The game is not in progress.' };
  if (room.activeCell) return { error: 'A question is already open.' };
  const cell = findCell(room, cellId);
  if (!cell) return { error: "That question doesn't exist." };
  if (cell.used) return { error: 'That question is already used.' };
  cell.used = true;
  room.activeCell = cellId;
  room.cellState = {
    cellId,
    stage: 'answering', // answering -> revealed -> closed
    answers: { teamA: null, teamB: null },
    locked: { teamA: false, teamB: false },
    judged: { teamA: null, teamB: null }, // null | 'correct' | 'wrong'
    stealTeam: null,
    stealAnswer: null,
    stealJudged: null // null | 'correct' | 'wrong'
  };
  return { room };
}

function submitAnswer(room, socketId, team, text) {
  const cs = room.cellState;
  if (!cs || cs.cellId !== room.activeCell) return { error: 'No question is open.' };
  if (cs.stage !== 'answering') return { error: 'Answers are locked in for this question.' };
  const player = room.players.get(socketId);
  if (!player || player.role !== team) return { error: 'Not on this team.' };
  if (cs.locked[team]) return { error: 'Your team already locked in an answer.' };
  const clean = (text || '').trim().slice(0, 200);
  if (!clean) return { error: 'Type an answer first.' };
  cs.answers[team] = clean;
  cs.locked[team] = true;
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

function judgeAnswer(room, socketId, team, correct) {
  if (room.hostId !== socketId) return { error: 'Only the host can judge answers.' };
  const cs = room.cellState;
  if (!cs || cs.stage !== 'revealed') return { error: 'Reveal the answer first.' };
  if (cs.judged[team]) return { error: 'Already judged.' };
  const cell = findCell(room, cs.cellId);
  cs.judged[team] = correct ? 'correct' : 'wrong';
  if (correct) room.scores[team] += cell.value;
  return { room };
}

function openSteal(room, socketId, stealingTeam) {
  if (room.hostId !== socketId) return { error: 'Only the host can offer a steal.' };
  const cs = room.cellState;
  if (!cs || cs.stage !== 'revealed') return { error: 'Reveal the answer first.' };
  if (cs.judged[otherTeam(stealingTeam)] !== 'wrong') return { error: "The other team wasn't marked wrong." };
  if (cs.judged[stealingTeam] === 'correct') return { error: 'That team already answered correctly.' };
  cs.stealTeam = stealingTeam;
  cs.stealAnswer = null;
  cs.stealJudged = null;
  return { room };
}

function submitSteal(room, socketId, text) {
  const cs = room.cellState;
  if (!cs || !cs.stealTeam) return { error: 'No steal is open.' };
  const player = room.players.get(socketId);
  if (!player || player.role !== cs.stealTeam) return { error: 'Not on the stealing team.' };
  if (cs.stealAnswer != null) return { error: 'Steal answer already submitted.' };
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
    // Wrong steal earns the original (missed) team a bonus hint.
    const originalTeam = otherTeam(cs.stealTeam);
    room.hints[originalTeam] += 1;
  }
  return { room };
}

function closeCell(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can close the question.' };
  if (!room.cellState) return { error: 'No question is open.' };
  room.activeCell = null;
  room.cellState = null;
  if (room.board.every(c => c.used)) room.phase = 'finished';
  return { room };
}

function giveHint(room, socketId, team) {
  if (room.hostId !== socketId) return { error: 'Only the host can give hints.' };
  if (room.hints[team] <= 0) return { error: 'No hints left for that team.' };
  room.hints[team] -= 1;
  return { room };
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

function startComeback(room, socketId, team, playerId) {
  if (room.hostId !== socketId) return { error: 'Only the host can start the comeback round.' };
  const gap = Math.abs(room.scores.teamA - room.scores.teamB);
  if (gap < COMEBACK_GAP) return { error: `Needs a ${COMEBACK_GAP}+ point gap to trigger.` };
  const losingTeam = room.scores.teamA < room.scores.teamB ? 'teamA' : 'teamB';
  if (team !== losingTeam) return { error: 'Only the team that is behind can attempt the comeback round.' };
  const player = room.players.get(playerId);
  if (!player || player.role !== team) return { error: 'Pick a player on that team.' };
  room.comeback = { team, playerId, playerName: player.name, active: true, points: 0 };
  return { room };
}

function finishComeback(room, socketId, points) {
  const cb = room.comeback;
  if (!cb || !cb.active) return { error: 'No comeback round in progress.' };
  if (socketId !== cb.playerId) return { error: 'Only the player attempting it can finish it.' };
  const earned = Math.max(0, parseInt(points, 10) || 0);
  room.scores[cb.team] += earned;
  room.comeback = { ...cb, active: false, points: earned };
  return { room };
}

function clearComebackBanner(room, socketId) {
  if (room.hostId !== socketId) return { error: 'Only the host can dismiss this.' };
  room.comeback = null;
  return { room };
}

// What actually goes out over the wire -- board cells hide their answers
// unless used+revealed (or the viewer is the host, handled by the caller
// sending a separate host-only payload).
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
    active: activeCell && cs ? {
      cellId: cs.cellId,
      column: activeCell.column,
      value: activeCell.value,
      stage: cs.stage,
      content: publicCellContent(activeCell, forHost || cs.stage === 'revealed'),
      answers: forHost ? cs.answers : {
        teamA: cs.locked.teamA ? cs.answers.teamA : null,
        teamB: cs.locked.teamB ? cs.answers.teamB : null
      },
      locked: cs.locked,
      judged: cs.judged,
      stealTeam: cs.stealTeam,
      stealAnswer: cs.stealAnswer,
      stealJudged: cs.stealJudged
    } : null
  };
}

module.exports = {
  startGame, openCell, submitAnswer, revealAnswer, judgeAnswer,
  openSteal, submitSteal, judgeSteal, closeCell, giveHint, usePhoneAFriend,
  startComeback, finishComeback, clearComebackBanner,
  serializeBoard, COMEBACK_GAP, STARTING_HINTS
};
