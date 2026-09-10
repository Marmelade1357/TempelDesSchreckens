(function () {
  // Ermittelt automatisch, unter welchem Pfad-Präfix diese Seite gerade läuft
  // (z.B. "" bei direktem Zugriff, "/tempel" wenn über einen gemeinsamen
  // Reverse-Proxy/Hub unter einem Unterpfad eingebunden).
  const MOUNT_PREFIX = window.location.pathname.replace(/\/[^/]*$/, '');
  const socket = io({ path: MOUNT_PREFIX + '/socket.io/' });

  if (MOUNT_PREFIX) {
    const backHub = document.getElementById('btn-back-hub-home');
    if (backHub) {
      backHub.href = '/';
      backHub.classList.remove('hidden');
    }
  }

  const SESSION_KEY = 'tempel_session';
  const CONTENT_ICON = { gold: '🪙', falle: '🔥', leer: '⬜' };
  const CONTENT_LABEL = { gold: 'Gold gefunden!', falle: 'Feuerfalle!', leer: 'Leere Kammer.' };
  const ROLE_LABEL = { abenteurer: 'Abenteurer(in)', waechterin: 'Wächterin' };

  // Bild-Platzhalter (public/assets/tds-*.*) - Dateinamen nach dem Schema des
  // Referenz-Projekts. Fehlt eine Datei (noch nicht ersetzt/entfernt), fällt
  // die Oberfläche automatisch auf das Emoji-Symbol zurück (siehe cardImg()).
  const CONTENT_IMG = { gold: 'assets/tds-gold.jpeg', falle: 'assets/tds-fire.jpeg', leer: 'assets/tds-empty.jpeg' };
  const CHAMBER_BACK_IMG = 'assets/tds-chamber.jpeg';
  const ROLE_IMG = { abenteurer: 'assets/tds-adventurer.jpeg', waechterin: 'assets/tds-guardian.jpeg' };

  function cardImg(src, alt) {
    return el('img', { src, alt: alt || '', onerror: (e) => e.target.remove() });
  }

  let session = null; // { code, playerId, token, name }
  let latestState = null;
  let latestInfo = null; // { role, ownTally }
  let keyOverlayShownFor = null;
  let removeBotConfirmId = null;

  // ---------------------------------------------------------------------
  // Sound-Effekte (Kartenumdrehen)
  // ---------------------------------------------------------------------

  const SOUND_KEY = 'tempel_sound_enabled';
  let soundEnabled = true;
  try { const s = localStorage.getItem(SOUND_KEY); if (s !== null) soundEnabled = s === '1'; } catch (e) { /* ignore */ }

  const SOUNDS = {
    start: new Audio(MOUNT_PREFIX + '/assets/audio/flip-start.mp3'),
    gold: new Audio(MOUNT_PREFIX + '/assets/audio/flip-gold.mp3'),
    falle: new Audio(MOUNT_PREFIX + '/assets/audio/flip-fire.mp3'),
    leer: new Audio(MOUNT_PREFIX + '/assets/audio/flip-empty.mp3'),
  };
  Object.values(SOUNDS).forEach((a) => { a.preload = 'auto'; a.volume = 0.7; });

  function playSound(name) {
    if (!soundEnabled) return;
    const a = SOUNDS[name];
    if (!a) return;
    try { a.currentTime = 0; a.play().catch(() => {}); } catch (e) { /* Autoplay-Policy o.Ä. - einfach ignorieren */ }
  }

  function updateSoundButton() {
    const btn = $('btn-sound-toggle');
    if (btn) btn.textContent = soundEnabled ? '🔊' : '🔇';
  }

  function vibrate(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (e) { /* Vibration ist optional */ }
    }
  }

  // Kurzer, synthetischer Zwei-Ton-Hinweis, sobald man selbst den Schlüssel
  // bekommt (also eine Kammer öffnen darf) - unabhängig von den mp3-Umdreh-
  // Sounds oben, damit er auch ohne die (austauschbaren) Audio-Dateien
  // funktioniert. Rein additiv, siehe playSound() weiter oben.
  let audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    } catch (e) { audioCtx = null; }
    return audioCtx;
  }
  function playTone(freq, duration, delay, volume) {
    if (!soundEnabled) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const t0 = ctx.currentTime + (delay || 0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(volume || 0.15, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch (e) { /* Sound ist rein kosmetisch - Fehler einfach ignorieren */ }
  }
  function playTurnAlert() { playTone(660, 0.1, 0, 0.14); playTone(880, 0.12, 0.1, 0.14); }

  // ---------------------------------------------------------------------
  // Screen Wake Lock - verhindert, dass sich das Handy während des Spiels
  // von selbst abschaltet/sperrt (z.B. während man auf den Schlüssel
  // wartet). Rein additiv, siehe Bluff/Poker für dasselbe Muster.
  // ---------------------------------------------------------------------
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* z.B. Tab nicht sichtbar oder nicht unterstützt - ignorieren */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    const homeScreen = document.getElementById('screen-home');
    const onHomeScreen = homeScreen && !homeScreen.classList.contains('hidden');
    if (document.visibilityState === 'visible' && !onHomeScreen) requestWakeLock();
  });

  // ---------------------------------------------------------------------
  // Helfer
  // ---------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function show(elm) { elm.classList.remove('hidden'); }
  function hide(elm) { elm.classList.add('hidden'); }
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => hide(s));
    show($(id));
    if (id === 'screen-home') releaseWakeLock(); else requestWakeLock();
  }

  // Zwei-Klick-Bestätigung, analog zum bestehenden "Bot entfernen"-Muster -
  // verhindert, dass ein Fehltipp auf "Verlassen" sofort den eigenen Platz
  // aufgibt (anders als ein Verbindungsabbruch lässt sich das nicht per
  // Reconnect rückgängig machen).
  function attachConfirmClick(btn, onConfirm) {
    if (!btn) return;
    const originalText = btn.textContent;
    let confirmTimer = null;
    const reset = () => { clearTimeout(confirmTimer); confirmTimer = null; btn.classList.remove('danger'); btn.textContent = originalText; };
    btn.addEventListener('click', () => {
      if (confirmTimer) { reset(); onConfirm(); return; }
      btn.classList.add('danger');
      btn.textContent = 'Sicher?';
      confirmTimer = setTimeout(reset, 3000);
    });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(t), 3200);
  }

  function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
  function clearSession() { localStorage.removeItem(SESSION_KEY); session = null; }
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function myId() { return session ? session.playerId : null; }

  function el(tag, opts, children) {
    const e = document.createElement(tag);
    if (opts) {
      Object.entries(opts).forEach(([k, v]) => {
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      });
    }
    (children || []).forEach((c) => e.appendChild(c));
    return e;
  }

  function findPlayer(state, id) {
    return (state.players || []).find((p) => p.id === id);
  }

  // ---------------------------------------------------------------------
  // Start-Bildschirm
  // ---------------------------------------------------------------------

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => hide(p));
      show($('tab-' + btn.dataset.tab));
    });
  });

  $('btn-create').addEventListener('click', () => {
    const name = $('create-name').value.trim();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    socket.emit('createRoom', { name }, (res) => {
      if (!res.ok) return toast(res.error || 'Fehler beim Erstellen.');
      session = { code: res.code, playerId: res.playerId, token: res.token, name };
      saveSession();
    });
  });

  $('btn-join').addEventListener('click', () => {
    const name = $('join-name').value.trim();
    const code = $('join-code').value.trim().toUpperCase();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    if (!code) return toast('Bitte gib den Raum-Code ein.');
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res.ok) return toast(res.error || 'Beitritt fehlgeschlagen.');
      session = { code: res.code, playerId: res.playerId, token: res.token, name };
      saveSession();
    });
  });

  attachConfirmClick($('btn-leave-lobby'), () => {
    socket.emit('leaveRoom');
    clearSession();
    showScreen('screen-home');
  });

  attachConfirmClick($('btn-leave-game'), () => {
    socket.emit('leaveRoom');
    clearSession();
    showScreen('screen-home');
  });

  // ---------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------

  $('btn-sound-toggle').addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    try { localStorage.setItem(SOUND_KEY, soundEnabled ? '1' : '0'); } catch (e) { /* ignore */ }
    updateSoundButton();
    if (soundEnabled) playSound('start');
  });
  updateSoundButton();

  $('btn-add-bot').addEventListener('click', () => socket.emit('addBot'));
  $('btn-fill-bots').addEventListener('click', () => socket.emit('fillBots'));
  $('btn-start').addEventListener('click', () => socket.emit('startGame'));
  $('setting-afk-timeout').addEventListener('change', (e) => socket.emit('updateSettings', { afkTimeoutEnabled: e.target.checked }));

  let lastSeenRoundNumber = 0;

  function renderLobby(state) {
    lastSeenRoundNumber = 0;
    keyOverlayShownFor = null;
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = state.players.length;

    const list = $('lobby-players');
    list.innerHTML = '';
    const amHost = state.hostId === myId();

    state.players.forEach((p) => {
      const classes = ['player-name'];
      const nameParts = [el('span', { text: (p.isBot ? '🤖 ' : '') + p.name })];
      if (p.isHost) nameParts.push(el('span', { class: 'tag host', text: 'Host' }));
      if (!p.connected && !p.isBot) nameParts.push(el('span', { class: 'tag', text: 'getrennt' }));
      const nameEl = el('div', { class: classes.join(' ') }, nameParts);

      const li = el('li', { class: !p.connected && !p.isBot ? 'disconnected' : '' }, [nameEl]);

      if (amHost && p.isBot) {
        if (removeBotConfirmId === p.id) {
          li.appendChild(el('button', {
            class: 'remove-bot-btn confirm',
            text: 'Entfernen?',
            onclick: () => { socket.emit('removeBot', { botId: p.id }); removeBotConfirmId = null; },
          }));
        } else {
          li.appendChild(el('button', {
            class: 'remove-bot-btn',
            text: '✕',
            onclick: () => { removeBotConfirmId = p.id; renderLobby(latestState); },
          }));
        }
      }
      list.appendChild(li);
    });

    if (amHost) {
      show($('lobby-bot-controls'));
      if (state.players.length < state.minPlayers) show($('btn-fill-bots'));
      else hide($('btn-fill-bots'));
    } else {
      hide($('lobby-bot-controls'));
    }

    const dist = $('lobby-distribution');
    if (state.roleCounts && state.chamberCounts) {
      dist.innerHTML = '';
      dist.appendChild(el('div', {
        html: `Bei <strong>${state.players.length}</strong> Spieler(n): <strong>${state.roleCounts.abenteurer}</strong> Abenteurer, <strong>${state.roleCounts.waechterin}</strong> Wächterinnen · Schatzkammern: <strong>${state.chamberCounts.gold}</strong>× Gold, <strong>${state.chamberCounts.falle}</strong>× Feuerfalle, <strong>${state.chamberCounts.leer}</strong>× leer.`,
      }));
      show(dist);
    } else {
      hide(dist);
    }

    const settingsBox = $('lobby-settings');
    const settingsDisplay = $('lobby-settings-display');
    const afkEnabled = !state.settings || state.settings.afkTimeoutEnabled !== false;
    if (amHost) {
      show(settingsBox);
      hide(settingsDisplay);
      $('setting-afk-timeout').checked = afkEnabled;
    } else {
      hide(settingsBox);
      if (afkEnabled) {
        settingsDisplay.textContent = '⏱️ Auto-Zug nach 60s Inaktivität aktiv.';
        show(settingsDisplay);
      } else {
        hide(settingsDisplay);
      }
    }

    const n = state.players.length;
    if (amHost) {
      if (n >= state.minPlayers && n <= state.maxPlayers) {
        show($('btn-start'));
        $('lobby-status').textContent = '';
      } else {
        hide($('btn-start'));
        $('lobby-status').textContent = n < state.minPlayers
          ? `Mindestens ${state.minPlayers} Spieler nötig.`
          : `Maximal ${state.maxPlayers} Spieler erlaubt.`;
      }
    } else {
      hide($('btn-start'));
      $('lobby-status').textContent = 'Warte, bis der Host das Spiel startet …';
    }
  }

  // ---------------------------------------------------------------------
  // Spiel: Sitzordnung (eigener Platz immer unten)
  // ---------------------------------------------------------------------

  function layoutOrder(state) {
    const n = state.players.length;
    const mi = state.players.findIndex((p) => p.id === myId());
    const startIdx = mi >= 0 ? mi : 0;
    const order = [];
    for (let k = 0; k < n; k++) order.push(state.players[(startIdx + k) % n]);
    return order;
  }

  // Eine Zeile pro Spieler:in - Name/Behauptung links, die eigenen
  // Schatzkammern als ausreichend groß dargestellte Karten rechts daneben
  // (statt eines kreisrunden Tisches mit winzigen Kammer-Symbolen).
  function renderPlayerRows(state) {
    const list = $('player-rows');
    list.innerHTML = '';
    const order = layoutOrder(state);

    order.forEach((p) => {
      const classes = ['player-row'];
      const isMe = p.id === myId();
      if (isMe) classes.push('me');
      if (state.keyPlayerId === p.id) classes.push('key-holder');
      if (!p.connected && !p.isBot) classes.push('disconnected');

      const tags = [];
      if (p.isHost) tags.push(el('span', { class: 'tag host', text: 'Host' }));
      if (isMe) tags.push(el('span', { class: 'tag me-tag', text: 'Du' }));
      if (!p.connected && !p.isBot) tags.push(el('span', { class: 'tag', text: 'getrennt' }));
      const tagsRow = el('div', { class: 'player-row-tags' }, tags);

      const nameEl = el('div', { class: 'player-row-name' }, [
        el('span', { text: (state.keyPlayerId === p.id ? '🔑 ' : '') + (p.isBot ? '🤖 ' : '') + p.name }),
      ]);

      const claim = state.claims[p.id];
      const claimEl = el('div', { class: 'player-row-claim', text: claim ? `„${claim.text}"` : '' });
      const countEl = el('div', { class: 'player-row-count', text: p.openChambers != null ? `${p.openChambers} geöffnet` : '' });

      const info = el('div', { class: 'player-row-info' }, [nameEl, tagsRow, claimEl, countEl]);

      const canPick = state.phase === 'playing' && state.keyPlayerId === myId() && p.id !== myId();
      const slots = (state.chambers[p.id] || []).map((slot, i) => {
        if (slot.revealed) {
          const div = el('div', {
            class: `chamber-slot revealed ${slot.content}`,
            text: CONTENT_ICON[slot.content] || '?',
            title: CONTENT_LABEL[slot.content] || '',
          });
          if (CONTENT_IMG[slot.content]) div.appendChild(cardImg(CONTENT_IMG[slot.content], CONTENT_LABEL[slot.content]));
          return div;
        }
        const opts = { class: 'chamber-slot' + (canPick ? ' pickable' : ''), text: '🔒' };
        if (canPick) {
          opts.onclick = () => socket.emit('openChamber', { targetPlayerId: p.id, slotIndex: i });
          opts.title = `Bei ${p.name} öffnen`;
        }
        const div = el('div', opts);
        div.appendChild(cardImg(CHAMBER_BACK_IMG, 'Verdeckte Kammer'));
        return div;
      });
      const chamberRow = el('div', { class: 'chamber-row' }, slots);

      // Nur in der eigenen Zeile: Gesamtstand der eigenen (noch verdeckten)
      // Kammern - niemand sonst darf das sehen, daher ausschließlich bei isMe.
      if (isMe && latestInfo && latestInfo.ownTally) {
        const t = latestInfo.ownTally;
        chamberRow.appendChild(el('div', { class: 'own-total-box', title: 'Gesamtstand deiner eigenen Kammern' }, [
          el('span', { class: 'own-total-chip gold', text: `🪙 ${t.gold}` }),
          el('span', { class: 'own-total-chip falle', text: `🔥 ${t.falle}` }),
          el('span', { class: 'own-total-chip leer', text: `⬜ ${t.leer}` }),
        ]));
      }

      list.appendChild(el('li', { class: classes.join(' ') }, [info, chamberRow]));
    });
  }

  function renderPileHint(state) {
    const bar = $('pile-hint-bar');
    if (state.phase === 'playing' || state.phase === 'reveal') {
      const keyPlayer = findPlayer(state, state.keyPlayerId);
      bar.textContent = keyPlayer ? `🗝️ ${keyPlayer.name} hat den Schlüssel` : '';
    } else {
      bar.textContent = '';
    }
    bar.classList.toggle('hidden', !bar.textContent);
  }

  function renderKeyOverlay(state) {
    if (!state.keyRoll || state.roundNumber !== 1) return;
    const marker = state.code + ':' + state.keyRoll.starterId;
    if (keyOverlayShownFor === marker) return;
    keyOverlayShownFor = marker;
    lastSeenRoundNumber = 1; // Runde 1 wird hier per Sound angekündigt, nicht nochmal vom Rundenwechsel-Sound
    playSound('start');

    const list = $('key-list');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const isWinner = p.id === state.keyRoll.starterId;
      list.appendChild(el('li', {
        class: isWinner ? 'winner' : '',
        text: `${p.name} ${isWinner ? '🔑 bekommt den Schlüssel!' : ''}`,
      }));
    });
    show($('key-overlay'));
    setTimeout(() => hide($('key-overlay')), 3400);
  }

  // Spielt den Start-Sound, sobald eine neue Runde (2, 3 oder 4) beginnt -
  // Runde 1 wird bereits vom Schlüssel-Overlay oben angekündigt.
  function maybeAnnounceRoundStart(state) {
    if ((state.phase === 'playing' || state.phase === 'reveal') && state.roundNumber > 0 && state.roundNumber !== lastSeenRoundNumber) {
      if (lastSeenRoundNumber !== 0) playSound('start');
      lastSeenRoundNumber = state.roundNumber;
    }
  }

  let lastRevealSoundKey = null;
  function renderRevealOverlay(state) {
    if (state.phase === 'reveal' && state.lastReveal) {
      const r = state.lastReveal;
      const target = findPlayer(state, r.targetId);
      const by = findPlayer(state, r.byId);
      $('reveal-icon').textContent = CONTENT_ICON[r.content] || '❓';
      const text = $('reveal-text');
      text.className = 'reveal-text ' + r.content;
      text.textContent = `${by ? by.name : '?'} öffnet bei ${target ? target.name : '?'}: ${CONTENT_LABEL[r.content] || ''}`;
      show($('reveal-overlay'));
      const key = r.round + ':' + r.byId + ':' + r.targetId + ':' + r.slotIndex;
      if (lastRevealSoundKey !== key) {
        lastRevealSoundKey = key;
        playSound(r.content);
      }
    } else {
      hide($('reveal-overlay'));
    }
  }

  function renderRoleAndTally(state) {
    const roleValue = $('role-panel-value');
    const roleImg = $('role-panel-img');
    if (latestInfo && latestInfo.role) {
      roleValue.textContent = ROLE_LABEL[latestInfo.role] || latestInfo.role;
      roleValue.className = 'role-panel-value ' + latestInfo.role;
      if (ROLE_IMG[latestInfo.role]) {
        if (roleImg.getAttribute('src') !== ROLE_IMG[latestInfo.role]) roleImg.setAttribute('src', ROLE_IMG[latestInfo.role]);
        roleImg.classList.remove('hidden');
      }
    } else {
      roleValue.textContent = '?';
      roleValue.className = 'role-panel-value';
      roleImg.classList.add('hidden');
    }

    const hint = $('turn-hint');
    if (state.phase === 'playing') {
      if (state.keyPlayerId === myId()) {
        hint.textContent = 'Du hast den Schlüssel! Klicke auf eine verdeckte Kammer bei einem Mitspieler.';
      } else {
        const kp = findPlayer(state, state.keyPlayerId);
        hint.textContent = kp ? `${kp.name} wählt gerade eine Kammer …` : '';
      }
    } else if (state.phase === 'reveal') {
      hint.textContent = 'Die Kammer wird geöffnet …';
    } else {
      hint.textContent = '';
    }
  }

  function renderRoundEnd(state) {
    if (state.phase !== 'roundend') { hide($('roundend-panel')); return; }
    $('roundend-number').textContent = state.roundNumber;
    const entry = state.history[state.history.length - 1];
    $('roundend-summary').textContent = entry
      ? `Bisher insgesamt gefunden: 🪙 ${state.foundGold}/${state.totalGold} Gold · 🔥 ${state.foundFire}/${state.totalFire} Feuerfallen · ⬜ ${state.foundEmpty} leere Kammern.`
      : '';
    const actions = $('roundend-actions');
    actions.innerHTML = '';
    if (state.hostId === myId()) {
      actions.appendChild(el('button', {
        class: 'btn primary',
        text: `Runde ${state.roundNumber + 1} starten`,
        onclick: () => socket.emit('nextRound'),
      }));
    } else {
      actions.appendChild(el('p', { class: 'hint', text: 'Warte auf den Host …' }));
    }
    show($('roundend-panel'));
  }

  function renderGameEnd(state) {
    if (state.phase !== 'gameend') { hide($('gameend-panel')); return; }
    const won = state.winner === 'abenteurer';
    $('gameend-title').textContent = won ? '🏆 Die Abenteurer gewinnen!' : '🕯️ Die Wächterinnen gewinnen!';
    $('gameend-reason').textContent = state.winReason || '';

    const list = $('gameend-roles');
    list.innerHTML = '';
    if (state.roles) {
      state.players.forEach((p) => {
        const role = state.roles[p.id];
        const li = el('li', { class: role });
        if (ROLE_IMG[role]) {
          const img = cardImg(ROLE_IMG[role], ROLE_LABEL[role] || role);
          img.className = 'gameend-role-img';
          li.appendChild(img);
        }
        li.appendChild(document.createTextNode(`${p.name} war ${ROLE_LABEL[role] || role}`));
        list.appendChild(li);
      });
    }

    const actions = $('gameend-actions');
    actions.innerHTML = '';
    if (state.hostId === myId()) {
      actions.appendChild(el('button', {
        class: 'btn primary',
        text: 'Neues Spiel (zurück zur Lobby)',
        onclick: () => socket.emit('resetGame'),
      }));
    } else {
      actions.appendChild(el('p', { class: 'hint', text: 'Warte auf den Host …' }));
    }
    show($('gameend-panel'));
  }

  function renderGame(state) {
    $('game-code').textContent = state.code;
    $('round-badge').textContent = state.roundNumber ? `Runde ${state.roundNumber}/${state.maxRounds}` : '';
    $('tally-badge').textContent = state.totalGold != null
      ? `🪙 ${state.foundGold}/${state.totalGold} · 🔥 ${state.foundFire}/${state.totalFire}`
      : '';

    renderKeyOverlay(state);
    maybeAnnounceRoundStart(state);
    renderPileHint(state);
    renderPlayerRows(state);
    renderRevealOverlay(state);
    renderRoleAndTally(state);
    renderRoundEnd(state);
    renderGameEnd(state);

    if (state.phase === 'playing' || state.phase === 'reveal') show($('bottom-bar'));
    else hide($('bottom-bar'));
  }

  // ---------------------------------------------------------------------
  // Regeln- & Verlauf-Modal
  // ---------------------------------------------------------------------

  $('btn-show-rules-lobby').addEventListener('click', () => show($('rules-modal')));
  $('btn-show-rules').addEventListener('click', () => show($('rules-modal')));
  $('btn-close-rules-modal').addEventListener('click', () => hide($('rules-modal')));

  $('btn-show-history').addEventListener('click', () => {
    const content = $('history-content');
    content.innerHTML = '';
    if (latestState) {
      if (latestState.history.length) {
        latestState.history.forEach((h) => {
          content.appendChild(el('div', { class: 'history-round' }, [
            el('div', { class: 'history-round-title', text: `Runde ${h.round}` }),
            el('div', { text: `🪙 ${h.goldFound} Gold · 🔥 ${h.fireFound} Feuerfallen · ⬜ ${h.emptyFound} leer (insgesamt bis dahin)` }),
          ]));
        });
      }
      latestState.logs.slice().reverse().forEach((l) => {
        content.appendChild(el('div', { class: 'log-line', text: l.text }));
      });
    }
    show($('history-modal'));
  });
  $('btn-close-history-modal').addEventListener('click', () => hide($('history-modal')));

  // ---------------------------------------------------------------------
  // Socket-Events
  // ---------------------------------------------------------------------

  socket.on('connect', () => {
    session = loadSession();
    if (session && session.code) {
      socket.emit('joinRoom', { code: session.code, name: session.name, token: session.token }, (res) => {
        if (!res.ok) {
          clearSession();
          showScreen('screen-home');
          return;
        }
        session.playerId = res.playerId;
        session.token = res.token;
        saveSession();
      });
    }
  });

  socket.on('yourInfo', (info) => {
    latestInfo = info;
    if (latestState) {
      renderRoleAndTally(latestState);
      if (latestState.phase !== 'lobby') renderPlayerRows(latestState);
    }
  });

  let notifiedKeyMarker = null;
  function maybeNotifyMyTurn(state) {
    if (state.phase !== 'playing' || state.keyPlayerId !== myId()) return;
    // Zähle die bereits geöffneten Kammern insgesamt (über alle Spieler) - das
    // ändert sich bei jeder einzelnen Öffnung, auch wenn derselbe Spieler
    // innerhalb einer Runde mehrfach den Schlüssel bekommt (reine round/
    // keyPlayerId-Kombination würde solche Wiederholungen sonst verschlucken).
    let revealedCount = 0;
    Object.values(state.chambers || {}).forEach((slots) => {
      (slots || []).forEach((s) => { if (s && s.revealed) revealedCount++; });
    });
    const marker = state.code + ':' + state.roundNumber + ':' + revealedCount + ':' + state.keyPlayerId;
    if (marker === notifiedKeyMarker) return;
    notifiedKeyMarker = marker;
    playTurnAlert();
    vibrate(120);
  }

  socket.on('gameState', (state) => {
    latestState = state;
    maybeNotifyMyTurn(state);
    if (state.phase === 'lobby') {
      showScreen('screen-lobby');
      renderLobby(state);
    } else {
      showScreen('screen-game');
      renderGame(state);
    }
  });

  // Initialer Zustand, solange noch keine Verbindung/kein Raum besteht.
  session = loadSession();
  if (!session) showScreen('screen-home');
})();
