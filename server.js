// Tempel des Schreckens - Online-Server
// Einfacher, selbst-gehosteter Mehrspieler-Server auf Basis von Express + Socket.IO.
// Kann lokal, im Heimnetz oder z.B. auf einem Raspberry Pi laufen.
// Regelwerk: siehe README.md (Originalspiel von Yusuke Sato, Schmidt Spiele).

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Spielregeln / Konstanten
// ---------------------------------------------------------------------------

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const MAX_ROOMS = 500; // Sicherheitsventil gegen Speicher-Erschöpfung durch Missbrauch
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne verwechselbare Zeichen

const ROUNDS_TOTAL = 4;
const CARDS_PER_ROUND = [5, 4, 3, 2]; // Index 0 = Runde 1, ... Index 3 = Runde 4

// "Aufteilung der Rollen-Karten" aus der Anleitung. Summe kann n oder n+1 sein -
// bei n+1 wird 1 überzählige Rollen-Karte ungesehen aus dem Stapel genommen.
const ROLE_TABLE = {
  3: { abenteurer: 2, waechterin: 2 },
  4: { abenteurer: 3, waechterin: 2 },
  5: { abenteurer: 3, waechterin: 2 },
  6: { abenteurer: 4, waechterin: 2 },
  7: { abenteurer: 5, waechterin: 3 },
  8: { abenteurer: 6, waechterin: 3 },
  9: { abenteurer: 6, waechterin: 3 },
  10: { abenteurer: 7, waechterin: 4 },
};

// "Aufteilung der Schatzkammer-Karten" aus der Anleitung - Summe ergibt immer
// genau 5 Karten pro Spieler für Runde 1 (leer + gold + falle = 5 * Spieleranzahl).
const CHAMBER_TABLE = {
  3: { leer: 8, gold: 5, falle: 2 },
  4: { leer: 12, gold: 6, falle: 2 },
  5: { leer: 16, gold: 7, falle: 2 },
  6: { leer: 20, gold: 8, falle: 2 },
  7: { leer: 26, gold: 7, falle: 2 },
  8: { leer: 30, gold: 8, falle: 2 },
  9: { leer: 34, gold: 9, falle: 2 },
  10: { leer: 37, gold: 10, falle: 3 },
};

const CONTENT_LABELS = {
  gold: 'Gold gefunden! 🪙',
  falle: 'Feuerfalle! 🔥',
  leer: 'Leere Kammer.',
};

const BOT_NAME_POOL = [
  'Bot Schatzgräberin', 'Bot Fackelträger', 'Bot Maskenspiel', 'Bot Nachtschleicher',
  'Bot Talisman', 'Bot Grabräuber', 'Bot Sphinx', 'Bot Amulett', 'Bot Hieroglyphe',
];

function roleCountsFor(n) { return ROLE_TABLE[n] || null; }
function chamberCountsFor(n) { return CHAMBER_TABLE[n] || null; }

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function weightedPick(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// Einfaches Rate-Limiting (Schutz vor Missbrauch, da öffentlich erreichbar)
// ---------------------------------------------------------------------------

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

const rateLimitHits = new Map();

function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateLimitHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    rateLimitHits.set(key, hits);
    return true;
  }
  hits.push(now);
  rateLimitHits.set(key, hits);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitHits) {
    const fresh = hits.filter((t) => now - t < 10 * 60 * 1000);
    if (fresh.length) rateLimitHits.set(key, fresh);
    else rateLimitHits.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Raumverwaltung
// ---------------------------------------------------------------------------

const rooms = new Map(); // code -> room
const ROOM_CLEANUP_MS = 3 * 60 * 60 * 1000;

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: null,
    players: [], // { id, token, name, socketId, connected, isBot }
    phase: 'lobby', // lobby | playing | reveal | roundend | gameend
    roles: null, // playerId -> 'abenteurer' | 'waechterin' (nur an Besitzer + am Spielende öffentlich)
    chambers: null, // playerId -> [{ content, revealed }]
    remainingPool: [], // Inhalte, die noch nicht wieder ausgeteilt wurden
    claims: {}, // playerId -> { text, updatedAt }
    botClaimPending: new Set(),
    roundNumber: 0,
    roundOpenedCount: 0,
    keyPlayerId: null,
    keyRoll: null, // transient: { rolls: {playerId: true/false}, starterId } fürs Schlüssel-Overlay
    totalGold: 0,
    totalFire: 0,
    foundGold: 0,
    foundFire: 0,
    foundEmpty: 0,
    lastReveal: null,
    revealTimer: null,
    winner: null,
    winReason: null,
    history: [], // [{ round, goldFound, fireFound, emptyFound }]
    logs: [],
    lastActivity: Date.now(),
    cleanupTimer: null,
  };
  rooms.set(code, room);
  touchRoom(room);
  return room;
}

function touchRoom(room) {
  room.lastActivity = Date.now();
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => { rooms.delete(room.code); }, ROOM_CLEANUP_MS);
}

function log(room, text) {
  room.logs.push({ text, at: Date.now() });
  if (room.logs.length > 200) room.logs.shift();
}

function findPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId);
}

function findPlayerIndex(room, playerId) {
  return room.players.findIndex((p) => p.id === playerId);
}

function publicPlayer(room, p) {
  const slots = room.chambers ? room.chambers[p.id] : null;
  return {
    id: p.id,
    name: p.name,
    connected: p.connected,
    isHost: p.id === room.hostId,
    isBot: p.isBot === true,
    openChambers: slots ? slots.filter((s) => !s.revealed).length : null,
  };
}

// ---------------------------------------------------------------------------
// Aufbau der Rollen- und Schatzkammer-Stapel
// ---------------------------------------------------------------------------

function buildRolePool(n) {
  const rc = roleCountsFor(n);
  const pool = [];
  for (let i = 0; i < rc.abenteurer; i++) pool.push('abenteurer');
  for (let i = 0; i < rc.waechterin; i++) pool.push('waechterin');
  return pool; // Länge n oder n+1 - der Rest kommt unbesehen aus dem Spiel
}

function buildChamberPool(n) {
  const cc = chamberCountsFor(n);
  const pool = [];
  for (let i = 0; i < cc.leer; i++) pool.push('leer');
  for (let i = 0; i < cc.gold; i++) pool.push('gold');
  for (let i = 0; i < cc.falle; i++) pool.push('falle');
  return pool; // Länge = 5 * n
}

function ownTally(room, playerId) {
  const slots = room.chambers ? room.chambers[playerId] : null;
  if (!slots) return null;
  const t = { gold: 0, leer: 0, falle: 0 };
  slots.forEach((s) => { if (!s.revealed) t[s.content] += 1; });
  return t;
}

// ---------------------------------------------------------------------------
// Öffentlicher / privater Zustand
// ---------------------------------------------------------------------------

function publicState(room) {
  const n = room.players.length;
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map((p) => publicPlayer(room, p)),
    hostId: room.hostId,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    roleCounts: roleCountsFor(n),
    chamberCounts: chamberCountsFor(n),
    roundNumber: room.roundNumber,
    maxRounds: ROUNDS_TOTAL,
    cardsThisRound: room.roundNumber > 0 ? CARDS_PER_ROUND[room.roundNumber - 1] : null,
    totalGold: room.totalGold || null,
    totalFire: room.totalFire || null,
    foundGold: room.foundGold,
    foundFire: room.foundFire,
    foundEmpty: room.foundEmpty,
    keyPlayerId: room.keyPlayerId,
    keyRoll: room.keyRoll,
    chambers: room.chambers
      ? Object.fromEntries(room.players.map((p) => [
        p.id,
        (room.chambers[p.id] || []).map((s) => ({ revealed: s.revealed, content: s.revealed ? s.content : undefined })),
      ]))
      : {},
    claims: room.claims || {},
    lastReveal: room.lastReveal,
    winner: room.winner,
    winReason: room.winReason,
    roles: room.phase === 'gameend' ? room.roles : null,
    logs: room.logs.slice(-50),
    history: room.history,
  };
}

function sendInfoTo(room, player) {
  if (!player.socketId) return;
  io.to(player.socketId).emit('yourInfo', {
    role: room.roles ? room.roles[player.id] || null : null,
    ownTally: ownTally(room, player.id),
  });
}

function broadcastState(room) {
  io.to(room.code).emit('gameState', publicState(room));
  room.players.forEach((p) => sendInfoTo(room, p));
  scheduleBotClaims(room);
  scheduleBotTurnIfNeeded(room);
}

// ---------------------------------------------------------------------------
// Spielablauf
// ---------------------------------------------------------------------------

function startGame(room) {
  // Zufällige Sitzreihenfolge für diese Partie, unabhängig von der Beitrittsreihenfolge.
  room.players = shuffle(room.players);
  const n = room.players.length;

  const rolePool = shuffle(buildRolePool(n)).slice(0, n);
  room.roles = {};
  room.players.forEach((p, i) => { room.roles[p.id] = rolePool[i]; });

  const cc = chamberCountsFor(n);
  room.totalGold = cc.gold;
  room.totalFire = cc.falle;
  room.foundGold = 0;
  room.foundFire = 0;
  room.foundEmpty = 0;
  room.remainingPool = shuffle(buildChamberPool(n));
  room.roundNumber = 0;
  room.history = [];
  room.logs = [];
  room.winner = null;
  room.winReason = null;
  room.lastReveal = null;

  // Der Startspieler wird zufällig bestimmt (online lässt sich "wer zuletzt
  // einen Goldschatz gefunden hat" nicht ermitteln) und erhält die Schlüssel-Karte.
  const starter = room.players[Math.floor(Math.random() * n)];
  const rolls = {};
  room.players.forEach((p) => { rolls[p.id] = p.id === starter.id; });
  room.keyRoll = { rolls, starterId: starter.id };
  room.keyPlayerId = starter.id;
  log(room, `Das Spiel beginnt. ${starter.name} erhält die Schlüssel-Karte und eröffnet.`);

  startRound(room);
}

function startRound(room) {
  room.roundNumber += 1;
  const per = CARDS_PER_ROUND[room.roundNumber - 1];
  const pool = shuffle(room.remainingPool);
  room.chambers = {};
  let idx = 0;
  room.players.forEach((p) => {
    const slots = [];
    for (let s = 0; s < per; s++) {
      slots.push({ content: pool[idx], revealed: false });
      idx += 1;
    }
    room.chambers[p.id] = slots;
  });
  room.remainingPool = [];
  room.roundOpenedCount = 0;
  room.claims = {};
  room.botClaimPending = new Set();
  room.lastReveal = null;
  room.phase = 'playing';
  log(room, `Runde ${room.roundNumber} beginnt - jede/r erhält ${per} Schatzkammern.`);
  touchRoom(room);
}

const REVEAL_DELAY_MS = Number(process.env.REVEAL_DELAY_MS) || 2600;

function endGame(room, winner, reason) {
  room.phase = 'gameend';
  room.winner = winner;
  room.winReason = reason;
  const winnerLabel = winner === 'abenteurer' ? 'Die Abenteurer gewinnen!' : 'Die Wächterinnen gewinnen!';
  log(room, `Spielende: ${winnerLabel} (${reason})`);
  touchRoom(room);
  broadcastState(room);
}

function handleOpenChamber(room, actorId, targetPlayerId, slotIndex) {
  if (room.phase !== 'playing') return;
  if (!actorId || actorId !== room.keyPlayerId) return;
  if (!targetPlayerId || targetPlayerId === actorId) return;
  const actor = findPlayer(room, actorId);
  const target = findPlayer(room, targetPlayerId);
  if (!actor || !target) return;
  const slots = room.chambers[targetPlayerId];
  if (!slots) return;
  const slot = slots[slotIndex];
  if (!slot || slot.revealed) return;

  slot.revealed = true;
  const content = slot.content;
  room.roundOpenedCount += 1;
  if (content === 'gold') room.foundGold += 1;
  else if (content === 'falle') room.foundFire += 1;
  else room.foundEmpty += 1;

  room.lastReveal = { byId: actorId, targetId: targetPlayerId, slotIndex, content, round: room.roundNumber };
  log(room, `${actor.name} öffnet eine Kammer bei ${target.name}: ${CONTENT_LABELS[content]}`);

  if (room.foundGold >= room.totalGold) {
    endGame(room, 'abenteurer', 'Alle Goldschätze wurden rechtzeitig gefunden.');
    return;
  }
  if (room.foundFire >= room.totalFire) {
    endGame(room, 'waechterin', 'Alle Feuerfallen wurden aufgedeckt.');
    return;
  }

  room.keyPlayerId = targetPlayerId; // wessen Kammer geöffnet wurde, wird neue/r Schlüssel-Spieler/in
  const n = room.players.length;

  if (room.roundOpenedCount >= n) {
    const leftover = [];
    room.players.forEach((p) => {
      (room.chambers[p.id] || []).forEach((s) => { if (!s.revealed) leftover.push(s.content); });
    });
    room.remainingPool = leftover;
    room.history.push({
      round: room.roundNumber,
      goldFound: room.foundGold,
      fireFound: room.foundFire,
      emptyFound: room.foundEmpty,
    });

    if (room.roundNumber >= ROUNDS_TOTAL) {
      endGame(room, 'waechterin', `Nach ${ROUNDS_TOTAL} Runden wurde nicht das gesamte Gold gefunden.`);
      return;
    }

    room.phase = 'roundend';
    touchRoom(room);
    broadcastState(room);
    return;
  }

  room.phase = 'reveal';
  touchRoom(room);
  broadcastState(room);

  if (room.revealTimer) clearTimeout(room.revealTimer);
  room.revealTimer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.phase !== 'reveal') return;
    room.phase = 'playing';
    touchRoom(room);
    broadcastState(room);
  }, REVEAL_DELAY_MS);
}

function resetToLobby(room) {
  if (room.revealTimer) clearTimeout(room.revealTimer);
  room.phase = 'lobby';
  room.roles = null;
  room.chambers = null;
  room.remainingPool = [];
  room.claims = {};
  room.botClaimPending = new Set();
  room.roundNumber = 0;
  room.roundOpenedCount = 0;
  room.keyPlayerId = null;
  room.keyRoll = null;
  room.totalGold = 0;
  room.totalFire = 0;
  room.foundGold = 0;
  room.foundFire = 0;
  room.foundEmpty = 0;
  room.lastReveal = null;
  room.winner = null;
  room.winReason = null;
  room.history = [];
  room.logs = [];
  log(room, 'Zurück zur Lobby. Bereit für eine neue Partie.');
  touchRoom(room);
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

function addBot(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const usedNames = new Set(room.players.map((p) => p.name));
  const name = BOT_NAME_POOL.find((n) => !usedNames.has(n)) || `Bot ${room.players.length + 1}`;
  const bot = { id: makeId(), token: null, name, socketId: null, connected: true, isBot: true };
  room.players.push(bot);
  log(room, `${name} (Bot) wurde hinzugefügt.`);
  return bot;
}

const BOT_DELAY_MIN = Number(process.env.BOT_DELAY_MIN_MS) || 1200;
const BOT_DELAY_MAX = Number(process.env.BOT_DELAY_MAX_MS) || 3200;
const BOT_CLAIM_DELAY_MIN = Number(process.env.BOT_CLAIM_DELAY_MIN_MS) || 900;
const BOT_CLAIM_DELAY_MAX = Number(process.env.BOT_CLAIM_DELAY_MAX_MS) || 2600;

function randomDelay(min = BOT_DELAY_MIN, max = BOT_DELAY_MAX) {
  return min + Math.random() * (max - min);
}

// Bots behaupten - wie in der Anleitung beschrieben - so gut wie immer, Abenteurer
// zu sein, und geben zu ihren Schatzkammern entweder die Wahrheit oder eine
// erfundene, aber plausible Verteilung der gleichen Kartenzahl preis.
function generateBotClaim(room, bot) {
  const role = room.roles[bot.id];
  const tally = ownTally(room, bot.id) || { gold: 0, leer: 0, falle: 0 };
  const total = tally.gold + tally.leer + tally.falle;
  const lie = Math.random() < (role === 'waechterin' ? 0.75 : 0.3);

  let g = tally.gold;
  let l = tally.leer;
  let f = tally.falle;
  if (lie && total > 0) {
    g = Math.floor(Math.random() * (total + 1));
    f = Math.floor(Math.random() * (total - g + 1));
    l = total - g - f;
  }

  // Eine Wächterin gibt sich fast nie zu erkennen - Regel: "seltsamerweise
  // beteuern meist alle Spieler, dass sie Abenteurer sind".
  const claimedRole = (role === 'waechterin' && Math.random() < 0.05) ? 'waechterin' : 'abenteurer';
  const roleLabel = claimedRole === 'abenteurer' ? 'Abenteurer(in)' : 'Wächterin';

  const parts = [];
  if (g > 0) parts.push(`${g}× Gold`);
  if (f > 0) parts.push(`${f}× Feuerfalle`);
  parts.push(`${l}× leer`);
  return `Ich bin ${roleLabel} - bei mir: ${parts.join(', ')}.`;
}

function scheduleBotClaims(room) {
  if (room.phase !== 'playing') return;
  room.players.filter((p) => p.isBot).forEach((bot) => {
    if (room.claims[bot.id]) return;
    if (room.botClaimPending.has(bot.id)) return;
    room.botClaimPending.add(bot.id);
    const roundAtSchedule = room.roundNumber;
    setTimeout(() => {
      room.botClaimPending.delete(bot.id);
      if (!rooms.has(room.code)) return;
      if (room.phase !== 'playing' || room.roundNumber !== roundAtSchedule) return;
      if (room.claims[bot.id]) return;
      room.claims[bot.id] = { text: generateBotClaim(room, bot), updatedAt: Date.now() };
      touchRoom(room);
      broadcastState(room);
    }, randomDelay(BOT_CLAIM_DELAY_MIN, BOT_CLAIM_DELAY_MAX));
  });
}

function parseClaimGoldHint(text) {
  if (!text) return 0;
  const m = text.match(/(\d+)\s*×?\s*Gold/i);
  return m ? parseInt(m[1], 10) : 0;
}

function parseClaimRoleHint(text) {
  if (!text) return null;
  if (/wächterin/i.test(text)) return 'waechterin';
  if (/abenteurer/i.test(text)) return 'abenteurer';
  return null;
}

// Wählt, bei wem und welche Kammer ein Bot als Schlüssel-Spieler öffnet. Da
// niemand - auch der Bot selbst nicht - weiß, welche Position welchen Inhalt
// hat, kann die Position innerhalb einer Zielperson nur zufällig gewählt
// werden. Nur BEI WEM geöffnet wird, lässt sich anhand der (ggf. gelogenen)
// Behauptungen der Mitspieler grob gewichten.
function decideBotChoice(room, bot) {
  const myRole = room.roles[bot.id];
  const candidates = room.players.filter((p) => p.id !== bot.id && (room.chambers[p.id] || []).some((c) => !c.revealed));
  if (!candidates.length) return null;

  let target;
  if (myRole === 'abenteurer') {
    const weights = candidates.map((p) => {
      const claim = room.claims[p.id];
      const goldHint = claim ? parseClaimGoldHint(claim.text) : 0;
      const roleHint = claim ? parseClaimRoleHint(claim.text) : null;
      let w = 1 + goldHint * 1.5;
      if (roleHint === 'waechterin') w *= 0.3; // offen zugegebene Wächterin wirkt riskant
      return Math.max(0.1, w + Math.random());
    });
    target = weightedPick(candidates, weights);
  } else {
    // Wächterinnen haben kein verlässliches Signal für ein gutes Ziel -
    // im Wesentlichen zufällig, das entspricht der Unsicherheit im Original.
    const weights = candidates.map(() => 0.6 + Math.random());
    target = weightedPick(candidates, weights);
  }

  const openSlots = room.chambers[target.id]
    .map((c, i) => ({ c, i }))
    .filter((x) => !x.c.revealed);
  const pick = openSlots[Math.floor(Math.random() * openSlots.length)];
  return { targetPlayerId: target.id, slotIndex: pick.i };
}

function scheduleBotTurnIfNeeded(room) {
  if (room.phase !== 'playing') return;
  const actor = findPlayer(room, room.keyPlayerId);
  if (!actor || !actor.isBot) return;
  const snapshotKey = room.keyPlayerId;
  const snapshotRound = room.roundNumber;
  const snapshotOpened = room.roundOpenedCount;
  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.phase !== 'playing') return;
    if (room.keyPlayerId !== snapshotKey || room.roundNumber !== snapshotRound || room.roundOpenedCount !== snapshotOpened) return;
    const choice = decideBotChoice(room, actor);
    if (choice) handleOpenChamber(room, actor.id, choice.targetPlayerId, choice.slotIndex);
  }, randomDelay());
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, cb) => {
    try {
      if (isRateLimited(`createRoom:${getClientIp(socket)}`, 8, 60 * 1000)) {
        return cb({ ok: false, error: 'Zu viele neue Räume in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
      }
      if (rooms.size >= MAX_ROOMS) {
        return cb({ ok: false, error: 'Gerade sind zu viele Räume aktiv. Bitte versuche es in ein paar Minuten erneut.' });
      }
      name = (name || '').trim().slice(0, 20) || 'Spieler';
      const room = createRoom();
      const player = { id: makeId(), token: makeId(), name, socketId: socket.id, connected: true };
      room.hostId = player.id;
      room.players.push(player);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      log(room, `${name} hat den Raum erstellt.`);
      touchRoom(room);
      cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcastState(room);
    } catch (err) {
      cb({ ok: false, error: 'Raum konnte nicht erstellt werden.' });
    }
  });

  socket.on('joinRoom', ({ code, name, token }, cb) => {
    if (isRateLimited(`joinRoom:${getClientIp(socket)}`, 20, 60 * 1000)) {
      return cb({ ok: false, error: 'Zu viele Versuche in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
    }
    code = (code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Diesen Raum gibt es nicht.' });

    if (token) {
      const existing = room.players.find((p) => p.token === token);
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.playerId = existing.id;
        touchRoom(room);
        log(room, `${existing.name} ist wieder verbunden.`);
        cb({ ok: true, code: room.code, playerId: existing.id, token: existing.token, rejoined: true });
        broadcastState(room);
        return;
      }
    }

    if (room.phase !== 'lobby') {
      return cb({ ok: false, error: 'Das Spiel läuft bereits. Bitte warte auf die nächste Runde.' });
    }
    if (room.players.length >= MAX_PLAYERS) {
      return cb({ ok: false, error: `Der Raum ist bereits voll (max. ${MAX_PLAYERS} Spieler).` });
    }
    name = (name || '').trim().slice(0, 20) || 'Spieler';
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return cb({ ok: false, error: 'Dieser Name ist im Raum bereits vergeben.' });
    }
    const player = { id: makeId(), token: makeId(), name, socketId: socket.id, connected: true };
    room.players.push(player);
    if (!room.hostId) room.hostId = player.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    touchRoom(room);
    log(room, `${name} ist dem Raum beigetreten.`);
    cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
    broadcastState(room);
  });

  socket.on('leaveRoom', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;

    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p.id !== player.id);
      if (room.hostId === player.id) {
        room.hostId = room.players.length ? room.players[0].id : null;
      }
      log(room, `${player.name} hat den Raum verlassen.`);
    } else {
      player.connected = false;
      log(room, `${player.name} hat das Spiel verlassen.`);
    }

    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    touchRoom(room);
    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      broadcastState(room);
    }
  });

  socket.on('kickPlayer', ({ playerId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (playerId === room.hostId) return;
    room.players = room.players.filter((p) => p.id !== playerId);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('addBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    addBot(room);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('removeBot', ({ botId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    const bot = findPlayer(room, botId);
    if (!bot || !bot.isBot) return;
    room.players = room.players.filter((p) => p.id !== botId);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('fillBots', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    while (room.players.length < MIN_PLAYERS) addBot(room);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) return;
    startGame(room);
    broadcastState(room);
  });

  socket.on('setClaim', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'playing') return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;
    const clean = (text || '').trim().slice(0, 140);
    if (!clean) return;
    room.claims[player.id] = { text: clean, updatedAt: Date.now() };
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('openChamber', ({ targetPlayerId, slotIndex }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    handleOpenChamber(room, socket.data.playerId, targetPlayerId, slotIndex);
  });

  socket.on('nextRound', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'roundend') return;
    if (socket.data.playerId !== room.hostId) return;
    startRound(room);
    broadcastState(room);
  });

  socket.on('resetGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    resetToLobby(room);
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;
    player.connected = false;
    log(room, `${player.name} hat die Verbindung verloren.`);
    touchRoom(room);
    broadcastState(room);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Tempel des Schreckens läuft auf Port ${PORT}`);
    console.log(`Lokal öffnen unter: http://localhost:${PORT}`);
  });
}

module.exports = {
  buildRolePool, buildChamberPool, shuffle, roleCountsFor, chamberCountsFor,
  CARDS_PER_ROUND, ROUNDS_TOTAL, MIN_PLAYERS, MAX_PLAYERS,
};
