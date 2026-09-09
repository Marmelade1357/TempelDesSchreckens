// Regressionstest für den kompletten Spielablauf: Raum erstellen, mit Bots
// auffüllen, Spiel starten und so lange automatisch Kammern öffnen (per
// simplem Autopilot auf Basis der Bot-Entscheidungsfunktion des Servers, hier
// aber einfach über den Host-Client als "menschlichen" Spieler simuliert),
// bis das Spiel zu Ende ist. Prüft vor allem, dass der Server dabei nicht
// abstürzt oder hängen bleibt, und dass am Ende ein in sich stimmiges
// Ergebnis steht (Gold- und Feuerfallen-Zähler nie über dem jeweiligen
// Gesamtwert, Rollen beim Spielende korrekt aufgedeckt).

const { startServer, stopServer, connectClient, emitAsync, waitForState, assert } = require('./helpers');

const PORT = 3901;

// Simuliert einen mitspielenden Menschen: öffnet Kammern, wenn er am
// Schlüssel ist, und klickt als Host außerdem "Nächste Runde", sobald eine
// Runde zu Ende ist - sonst bliebe der Testlauf (wie ein echter, wartender
// Raum) im Rundenende-Bildschirm stehen, bis jemand das tut.
function attachAutopilot(socket, getMyId, getIsHost) {
  let handledRoundend = false;
  socket.on('gameState', (state) => {
    if (state.phase === 'roundend') {
      if (getIsHost() && !handledRoundend) {
        handledRoundend = true;
        socket.emit('nextRound');
      }
      return;
    }
    handledRoundend = false;
    if (state.phase !== 'playing') return;
    if (state.keyPlayerId !== getMyId()) return;
    const others = state.players.filter((p) => p.id !== getMyId() && (state.chambers[p.id] || []).some((c) => !c.revealed));
    if (!others.length) return;
    const target = others[Math.floor(Math.random() * others.length)];
    const openSlots = state.chambers[target.id].map((c, i) => ({ c, i })).filter((x) => !x.c.revealed);
    const pick = openSlots[Math.floor(Math.random() * openSlots.length)];
    socket.emit('openChamber', { targetPlayerId: target.id, slotIndex: pick.i });
  });
}

async function main() {
  const proc = await startServer(PORT, {
    BOT_DELAY_MIN_MS: '5',
    BOT_DELAY_MAX_MS: '20',
    BOT_CLAIM_DELAY_MIN_MS: '5',
    BOT_CLAIM_DELAY_MAX_MS: '20',
    REVEAL_DELAY_MS: '20',
  });
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);
    let myId = null;
    attachAutopilot(host, () => myId, () => true);

    const created = await emitAsync(host, 'createRoom', { name: 'TestHost' });
    assert(created.ok, `createRoom sollte erfolgreich sein, war aber: ${JSON.stringify(created)}`);
    myId = created.playerId;

    host.emit('addBot');
    host.emit('addBot');
    host.emit('addBot');
    host.emit('addBot');
    const lobbyState = await waitForState(host, (s) => s.players.length === 5);
    assert(lobbyState.players.length === 5, 'Raum sollte 5 Spieler haben (1 Mensch + 4 Bots)');
    assert(lobbyState.roleCounts && lobbyState.roleCounts.abenteurer === 3 && lobbyState.roleCounts.waechterin === 2, 'Rollenverteilung bei 5 Spielern sollte 3 Abenteurer / 2 Wächterinnen sein');
    assert(lobbyState.chamberCounts.gold === 7 && lobbyState.chamberCounts.falle === 2, 'Kammerverteilung bei 5 Spielern sollte 7 Gold / 2 Feuerfallen ergeben');

    host.emit('startGame');
    const playingState = await waitForState(host, (s) => s.phase === 'playing');
    assert(playingState.roundNumber === 1, 'Erste Runde sollte Nummer 1 haben');
    assert(playingState.keyPlayerId, 'Es sollte direkt eine Schlüssel-Spielerin/ein Schlüssel-Spieler feststehen');
    assert(playingState.totalGold === 7 && playingState.totalFire === 2, 'Gesamtzahl Gold/Feuerfallen sollte zur Spielerzahl passen');

    const totalChambers = playingState.players.reduce((sum, p) => sum + p.openChambers, 0);
    assert(totalChambers === 5 * 5, `In Runde 1 sollten 25 Kammern verteilt sein, waren aber ${totalChambers}`);

    // Spiel automatisch bis zum Ende durchspielen lassen (max. 4 Runden a max.
    // 5 Öffnungen, plus etwas Puffer für die Reveal-Pausen dazwischen).
    const endState = await waitForState(host, (s) => s.phase === 'gameend', 60000);
    assert(['abenteurer', 'waechterin'].includes(endState.winner), `Es sollte ein gültiger Gewinner feststehen, war aber: ${endState.winner}`);
    assert(endState.foundGold <= endState.totalGold, 'Gefundenes Gold darf die Gesamtzahl nicht übersteigen');
    assert(endState.foundFire <= endState.totalFire, 'Gefundene Feuerfallen dürfen die Gesamtzahl nicht übersteigen');
    assert(endState.roles && Object.keys(endState.roles).length === 5, 'Beim Spielende sollten alle 5 Rollen aufgedeckt sein');

    if (endState.winner === 'abenteurer') {
      assert(endState.foundGold === endState.totalGold, 'Bei einem Abenteurer-Sieg sollte alles Gold gefunden worden sein');
    } else {
      assert(endState.foundFire === endState.totalFire || endState.roundNumber === 4, 'Bei einem Wächterinnen-Sieg sollten entweder alle Feuerfallen aufgedeckt oder 4 Runden gespielt worden sein');
    }

    // Zurück zur Lobby.
    host.emit('resetGame');
    const lobbyAgain = await waitForState(host, (s) => s.phase === 'lobby');
    assert(lobbyAgain.roundNumber === 0, 'Nach resetGame sollte die Rundenzahl zurückgesetzt sein');

    console.log('OK: basic-game-flow.test.js');
  } finally {
    await stopServer(proc);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
