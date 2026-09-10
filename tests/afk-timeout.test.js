// Regressionstest für das AFK-Timeout: Eine verbundene, aber untätige
// Schlüssel-Spielerin/ein Schlüssel-Spieler (z. B. gesperrtes Handy) wird
// nach der eingestellten Zeit automatisch übersprungen - der Server öffnet
// eine zufällige Kammer bei einer anderen Person, damit der Tempel nicht
// unbegrenzt stehen bleibt. Prüft außerdem, dass der Host diese Funktion in
// den Lobby-Einstellungen abschalten kann.

const { startServer, stopServer, connectClient, emitAsync, waitForState, assert } = require('./helpers');

const AFK_TIMEOUT_MS = 300;
const FAST_ENV = {
  AFK_TIMEOUT_MS: String(AFK_TIMEOUT_MS),
  BOT_DELAY_MIN_MS: '20',
  BOT_DELAY_MAX_MS: '40',
  BOT_CLAIM_DELAY_MIN_MS: '20',
  BOT_CLAIM_DELAY_MAX_MS: '40',
  REVEAL_DELAY_MS: '30',
};

async function testEnabled() {
  const PORT = 3920;
  const proc = await startServer(PORT, FAST_ENV);
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);

    // Wer Schlüssel-Spieler:in wird, ist pro Runde zufällig - reicht die
    // Runde zu Ende, ohne dass wir je am Zug waren, klickt der Host (wie ein
    // wartender Mensch) automatisch "Nächste Runde", damit der Test nicht an
    // einem Rundenende hängen bleibt, das nichts mit dem AFK-Timeout zu tun hat.
    host.on('gameState', (s) => { if (s.phase === 'roundend') host.emit('nextRound'); });

    const created = await emitAsync(host, 'createRoom', { name: 'AFKHuman' });
    assert(created.ok, `createRoom fehlgeschlagen: ${JSON.stringify(created)}`);
    const myId = created.playerId;

    host.emit('addBot');
    host.emit('addBot');
    await waitForState(host, (s) => s.players.length === 3);
    host.emit('startGame');

    // Bewusst KEINE Aktion senden, sobald wir Schlüssel-Spieler:in sind -
    // simuliert genau das Szenario "Handy gesperrt, Person reagiert nicht".
    const myTurnState = await waitForState(host, (s) => s.phase === 'playing' && s.keyPlayerId === myId, 20000);
    assert(!!myTurnState, 'Sollte irgendwann Schlüssel-Spieler:in sein');
    const t0 = Date.now();

    const afterState = await waitForState(
      host,
      (s) => s.phase !== 'playing' || s.keyPlayerId !== myId,
      AFK_TIMEOUT_MS + 5000
    );
    const elapsed = Date.now() - t0;

    assert(
      elapsed >= AFK_TIMEOUT_MS - 100,
      `Zug wurde zu früh übersprungen (${elapsed}ms, Limit war ${AFK_TIMEOUT_MS}ms) - das AFK-Timeout wurde offenbar nicht abgewartet`
    );
    assert(
      afterState.phase !== 'playing' || afterState.keyPlayerId !== myId,
      'Der Schlüssel sollte nach dem AFK-Timeout automatisch weitergereicht worden sein (Kammer wurde automatisch geöffnet)'
    );

    console.log(`OK: afk-timeout.test.js - aktiviert (Zug nach ${elapsed}ms automatisch übersprungen)`);
  } finally {
    await stopServer(proc);
  }
}

async function testDisabled() {
  const PORT = 3921;
  const proc = await startServer(PORT, FAST_ENV);
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);
    let latestState = null;
    host.on('gameState', (s) => {
      latestState = s;
      // Siehe Kommentar in testEnabled(): Rundenenden, bei denen wir nicht
      // Schlüssel-Spieler:in waren, müssen wir wie ein wartender Mensch
      // weiterklicken, damit der Test nicht daran hängen bleibt.
      if (s.phase === 'roundend') host.emit('nextRound');
    });

    const created = await emitAsync(host, 'createRoom', { name: 'AFKHuman2' });
    assert(created.ok, `createRoom fehlgeschlagen: ${JSON.stringify(created)}`);
    const myId = created.playerId;

    host.emit('updateSettings', { afkTimeoutEnabled: false });
    host.emit('addBot');
    host.emit('addBot');
    await waitForState(host, (s) => s.players.length === 3 && s.settings.afkTimeoutEnabled === false);
    host.emit('startGame');

    await waitForState(host, (s) => s.phase === 'playing' && s.keyPlayerId === myId, 20000);

    // Deutlich länger als AFK_TIMEOUT_MS warten, ohne selbst zu handeln - bei
    // abgeschaltetem Timeout darf der Server NICHT automatisch für uns handeln.
    await new Promise((resolve) => setTimeout(resolve, AFK_TIMEOUT_MS * 4));

    assert(latestState.phase === 'playing' && latestState.keyPlayerId === myId,
      'Bei abgeschaltetem AFK-Timeout sollte der Schlüssel NICHT automatisch weitergereicht worden sein');

    console.log('OK: afk-timeout.test.js - abgeschaltet (kein automatischer Zug)');
  } finally {
    await stopServer(proc);
  }
}

async function main() {
  await testEnabled();
  await testDisabled();
}

main().catch((err) => {
  console.error('FEHLER in afk-timeout.test.js:', err);
  process.exitCode = 1;
});
