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

  // ---------------------------------------------------------------------
  // Helfer
  // ---------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function show(elm) { elm.classList.remove('hidden'); }
  function hide(elm) { elm.classList.add('hidden'); }
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => hide(s));
    show($(id));
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

  $('btn-leave-lobby').addEventListener('click', () => {
    socket.emit('leaveRoom');
    clearSession();
    showScreen('screen-home');
  });

  $('btn-leave-game').addEventListener('click', () => {
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

  function renderSeats(state) {
    const layer = $('seats-layer');
    layer.innerHTML = '';
    const order = layoutOrder(state);
    const n = order.length;
    const RX = 40, RY = 38;

    order.forEach((p, k) => {
      const angleDeg = 90 + (k * 360) / n;
      const rad = (angleDeg * Math.PI) / 180;
      const x = 50 + Math.cos(rad) * RX;
      const y = 50 + Math.sin(rad) * RY;

      const classes = ['seat'];
      const isMe = p.id === myId();
      if (isMe) classes.push('me');
      if (state.keyPlayerId === p.id) classes.push('key-holder');
      if (!p.connected && !p.isBot) classes.push('disconnected');

      const initial = p.isBot ? '🤖' : (p.name || '?').trim().charAt(0).toUpperCase();
      const avatar = el('div', { class: 'seat-avatar', text: initial });

      const tags = [];
      if (p.isHost) tags.push(el('span', { class: 'tag host', text: 'Host' }));
      if (state.keyPlayerId === p.id) tags.push(el('span', { class: 'seat-key', text: '🔑' }));
      const tagsRow = el('div', { class: 'seat-tags' }, tags);

      const claim = state.claims[p.id];
      const claimEl = el('div', { class: 'seat-claim', text: claim ? `„${claim.text}"` : '' });

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

      const seat = el('div', { class: classes.join(' ') }, [
        avatar,
        el('div', { class: 'seat-name', text: p.name }),
        tagsRow,
        claimEl,
        chamberRow,
      ]);
      seat.style.left = x + '%';
      seat.style.top = y + '%';
      layer.appendChild(seat);
    });
  }

  function renderPlayerPanel(state) {
    const list = $('player-panel-list');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const classes = ['player-panel-row'];
      if (p.id === myId()) classes.push('me');
      if (state.keyPlayerId === p.id) classes.push('key-holder');
      if (!p.connected && !p.isBot) classes.push('disconnected');

      const claim = state.claims[p.id];
      const nameEl = el('div', { class: 'player-panel-name' }, [
        el('span', { text: (state.keyPlayerId === p.id ? '🔑 ' : '') + (p.isBot ? '🤖 ' : '') + p.name }),
      ]);
      const wrap = el('div', {}, [
        nameEl,
        el('span', { class: 'player-panel-claim', text: claim ? `„${claim.text}"` : '' }),
      ]);
      const countEl = el('span', { class: 'player-panel-count', text: p.openChambers != null ? `🗝️ ${p.openChambers}` : '' });
      list.appendChild(el('li', { class: classes.join(' ') }, [wrap, countEl]));
    });
  }

  function renderPileHint(state) {
    const hintEl = $('pile-hint');
    if (state.phase === 'playing' || state.phase === 'reveal') {
      const keyPlayer = findPlayer(state, state.keyPlayerId);
      hintEl.textContent = keyPlayer ? `${keyPlayer.name} hat den Schlüssel` : '';
    } else {
      hintEl.textContent = '';
    }
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

  function renderRoleAndClaim(state) {
    const roleValue = $('role-panel-value');
    const roleTally = $('role-panel-tally');
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
    if (latestInfo && latestInfo.ownTally) {
      const t = latestInfo.ownTally;
      roleTally.textContent = `Bei dir noch verdeckt: 🪙 ${t.gold} · 🔥 ${t.falle} · ⬜ ${t.leer}`;
    } else {
      roleTally.textContent = '';
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

  $('btn-claim').addEventListener('click', () => {
    const text = $('claim-input').value.trim();
    if (!text) return;
    socket.emit('setClaim', { text });
    $('claim-input').value = '';
  });
  $('claim-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-claim').click();
  });

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
    renderPlayerPanel(state);
    renderSeats(state);
    renderPileHint(state);
    renderRevealOverlay(state);
    renderRoleAndClaim(state);
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
    if (latestState) renderRoleAndClaim(latestState);
  });

  socket.on('gameState', (state) => {
    latestState = state;
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
