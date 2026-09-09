# Tempel des Schreckens – Online

Eine browserbasierte Online-Version des Gesellschaftsspiels **„Tempel des Schreckens"** von Yusuke Sato (Schmidt Spiele) zum Spielen mit Freunden – jede:r auf dem eigenen Handy/Tablet/PC, ein gemeinsamer Server übernimmt Rollen-Verteilung, Schatzkammern und den Schlüssel-Wechsel.

Basiert auf dem offiziellen Regelwerk: 3–10 Spieler, zwei geheime Teams (Abenteurer vs. Wächterinnen), 4 Runden, in denen reihum Schatzkammern geöffnet werden – wer am Ende alles Gold birgt, gewinnt als Abenteurer-Team; wer die Abenteurer in alle Feuerfallen lockt oder einfach nur Zeit schindet, gewinnt als Wächterinnen.

## Funktionen

- **Automatische Rollen- und Kammer-Verteilung** nach den offiziellen Tabellen der Anleitung (Abenteurer/Wächterinnen- sowie Gold/leer/Feuerfalle-Verhältnis je nach Spieleranzahl).
- **Geheime Rolle** – jede:r sieht nur die eigene Rolle privat auf dem eigenen Gerät, aufgedeckt wird erst ganz am Spielende.
- **Verdeckte Schatzkammern** – jede:r kennt nur die Gesamtzahl an Gold/leer/Feuerfalle unter den eigenen (verdeckten) Kammern, nie die genaue Position – exakt wie beim „Anschauen, dann blind mischen" im Original.
- **Schlüssel-Mechanik**: Wer den Schlüssel hat, öffnet reihum bei einer Mitspielerin/einem Mitspieler eine Kammer; wessen Kammer geöffnet wurde, bekommt den Schlüssel als Nächste:r.
- **Behauptungen/Bluffs**: Jede Person kann jederzeit einen frei wählbaren Text absetzen (z. B. „Ich bin Abenteurer, 2× Gold bei mir") – sichtbar für alle, aber natürlich ungeprüft. Genau dieses Lügen und Diskutieren macht das Spiel aus.
- Automatische Rundenwechsel (5 → 4 → 3 → 2 Kammern pro Person) und Spielende-Erkennung nach den 3 offiziellen Bedingungen.
- Wiederverbindung nach Verbindungsabbruch/Neuladen der Seite (Sitzplatz, Rolle und Kammern bleiben erhalten).
- Läuft komplett im Speicher – keine Datenbank nötig, ideal für einen Raspberry Pi.
- **Test-Bots** – hat man allein oder zu zweit Lust zu testen, füllt man den Raum in der Lobby per Klick mit Bots auf (mind. 3 Spieler nötig). Bots geben (meist unehrliche) Behauptungen ab und öffnen als Schlüssel-Spieler eigenständig Kammern, basierend auf den öffentlichen Behauptungen der anderen.
- **Sound-Effekte** beim Öffnen einer Kammer (Gold/Feuerfalle/leer) und bei Rundenbeginn, per Klick im Spiel-Header stummschaltbar (Einstellung bleibt pro Gerät im Browser gespeichert).

## Sound-Assets

Die 4 Sound-Dateien unter `public/assets/audio/` (`flip-start.mp3`, `flip-gold.mp3`, `flip-fire.mp3`, `flip-empty.mp3`) sind generische Kartenumdreh-Soundeffekte.

## Bild-Assets (Platzhalter zum Selbst-Ersetzen)

Unter `public/assets/` liegen 12 Platzhalter-Bilder, benannt nach dem Dateischema des Referenz-Projekts [richardcrng/tempel-des-schreckens](https://github.com/richardcrng/tempel-des-schreckens). Es sind **eigene, einfache Zeichnungen** (Rahmen + Symbol + Beschriftung) – **keine** Scans/Fotos der offiziellen, illustrierten Schmidt-Spiele-Karten, da diese urheberrechtlich geschützt sind. Eigene Bilder einfach unter demselben Dateinamen in `public/assets/` ablegen (JPEG bzw. PNG, wie angegeben) und den Server neu starten/den Container neu bauen – kein Code muss angepasst werden:

| Datei | Wo sie im Spiel auftaucht |
|---|---|
| `tds-adventurer.jpeg` | Rollen-Anzeige unten im Spiel + Rollen-Aufdeckung am Spielende (wenn die Rolle „Abenteurer" ist) |
| `tds-guardian.jpeg` | Dasselbe für die Rolle „Wächterin" |
| `tds-gold.jpeg` | Aufgedeckte Schatzkammer mit Gold |
| `tds-fire.jpeg` | Aufgedeckte Schatzkammer mit Feuerfalle |
| `tds-empty.jpeg` | Aufgedeckte leere Schatzkammer |
| `tds-chamber.jpeg` | Verdeckte (noch nicht geöffnete) Schatzkammer – die „Rückseite" |
| `tds-key.jpeg` | Bild im „Wer bekommt den Schlüssel?"-Overlay |
| `tds-box.png` | Aktuell nicht verankert – frei für eigene Verwendung (z. B. Box-Cover) |
| `tds-main.jpeg` | Banner oben auf dem Start-Bildschirm |
| `tds-alignments.jpeg` | Bild im Regeln-Modal (Abschnitt „Vorbereitung", Rollenverteilung) |
| `tds-contents.jpeg` | Bild im Regeln-Modal (Abschnitt „Rundenende", Kammer-Inhalte) |
| `tds-focus.jpeg` | Aktuell nicht verankert – frei für eigene Verwendung |

Fehlt eine Datei (z. B. gelöscht statt ersetzt), fällt die Oberfläche automatisch auf das ursprüngliche Emoji-Symbol zurück (🪙 🔥 ⬜ 🔒 🔑) – nichts bricht.

## Projektstruktur

```
TempelDesSchreckens/
├── server.js            Spiel-Server (Node.js, Express + Socket.IO)
├── package.json
├── Dockerfile           Container-Image für den Server
├── docker-compose.yml   Für den Betrieb auf dem Pi (siehe unten)
├── public/
│   ├── index.html         Oberfläche
│   ├── style.css          Design
│   └── client.js          Spiellogik im Browser
├── tests/               Automatisierte Integrationstests (siehe unten)
├── .github/workflows/   GitHub-Actions-CI, läuft bei jedem Push automatisch
└── README.md            Diese Anleitung
```

## Lokal testen (z. B. auf deinem Windows-PC)

Voraussetzung: [Node.js](https://nodejs.org) (Version 18 oder neuer empfohlen).

```bash
cd TempelDesSchreckens
npm install
npm start
```

Danach im Browser öffnen: `http://localhost:3000`

Zum Testen mit mehreren „Spielern" einfach mehrere Browser-Tabs oder -Fenster öffnen, oder in der Lobby Bots hinzufügen.

## Automatisierte Tests

Unter `tests/` liegt ein Integrationstest, der den Server als echten Prozess startet und über `socket.io-client` eine komplette Partie mit Bots durchspielt. Er prüft vor allem, dass der Server dabei nicht abstürzt und am Ende ein in sich stimmiges Ergebnis steht (Rollen- und Kammer-Verteilung passend zur Spieleranzahl, Gold-/Feuerfallen-Zähler nie über der Gesamtzahl, Gewinnbedingung konsistent mit den aufgedeckten Zahlen).

```bash
npm install
npm test
```

Bei jedem Push nach GitHub läuft das automatisch über eine GitHub Action (`.github/workflows/ci.yml`) mit.

## Mit Freunden im selben WLAN spielen

1. Server wie oben starten (`npm start`).
2. Die lokale IP-Adresse deines Rechners herausfinden (Windows: `ipconfig`, unter „IPv4-Adresse", z. B. `192.168.1.42`).
3. Freunde im selben WLAN öffnen im Browser: `http://192.168.1.42:3000`
4. Eine Person erstellt einen Raum und teilt den 4-stelligen Raum-Code, alle anderen treten mit Namen + Code bei.

## Dauerhaft auf dem Raspberry Pi hosten

Läuft nach dem gleichen Docker-Muster wie deine anderen Projekte (Widerstand, Wizard, Bluff): ein Container mit dem Node-Server, per Compose verwaltet, und dein bestehender Reverse Proxy auf dem Pi übernimmt das Routing der Domain.

Bereits belegte interne Ports auf dem Pi: `8080/8443` (FinanceAgent), `8090/8091` (Monitoring Shop), `8092` (Widerstand), `8093` (Wizard), `8094` (Spielehub/Poker), `8095` (Bluff). Tempel des Schreckens nutzt deshalb **Port 8096**.

### 1. Projekt auf den Pi bringen

Wie bei den anderen Projekten – per `git push` auf dein Repo und auf dem Pi `git pull`, oder direkt per `scp`/USB-Stick den `TempelDesSchreckens`-Ordner kopieren.

### 2. Container bauen und starten

```bash
cd TempelDesSchreckens
docker compose up -d --build
```

Das war's – `docker-compose.yml` startet den Server und bindet ihn **nur lokal** an `127.0.0.1:8096` (also nicht direkt von außen erreichbar, nur über deinen Reverse Proxy). Ob der Container läuft, prüfst du mit:

```bash
docker compose ps
docker compose logs -f
```

Nach Code-Änderungen genügt `./deploy.sh` (führt `git pull && docker compose up -d --build` aus).

### 3. Reverse Proxy: tempel.oualid.de → Port 8096

Trag bei deinem Reverse Proxy auf dem Pi einen neuen Eintrag ein, der auf `127.0.0.1:8096` zeigt – **wichtig ist, dass WebSockets/Upgrade-Header durchgereicht werden**, sonst bricht die Live-Verbindung (Socket.IO) ab (genau wie bei `wd.oualid.de`, `wizard.oualid.de` und `bluff.oualid.de` bereits eingerichtet).

### 4. Optional: In den Spielehub einhängen

Soll das Spiel wie „Der Widerstand", „Wizard" und „Bluff" über `games.oualid.de/tempel/` erreichbar sein, in `Spielehub/nginx.conf` einen weiteren `location /tempel/`-Block (analog zu `/bluff/`, Ziel `127.0.0.1:8096`) sowie in `Spielehub/public/index.html` eine weitere Kachel ergänzen.

### 5. DNS-Eintrag

Bei deinem DNS-Anbieter für `oualid.de` einen neuen **A-Eintrag** anlegen, der auf dieselbe IP zeigt wie deine anderen Subdomains.

### Sicherheitshinweis

Es gibt aktuell keinen Zugriffsschutz (kein Passwort) – wer die URL und einen Raum-Code kennt, kann beitreten. Für ein privates Spiel im Freundeskreis meist unkritisch, aber gut zu wissen, bevor der Link weiter verbreitet wird.

## Spielablauf in der Web-Version

1. **Raum erstellen** (ein Spieler) → Raum-Code an alle anderen weitergeben.
2. Alle **treten mit Namen bei** (3–10 Spieler nötig).
3. Host klickt **„Spiel starten"** → Rollen und je 5 Schatzkammern werden automatisch verteilt, jede:r sieht privat seine Rolle und die Gesamtzahl (Gold/leer/Feuerfalle) der eigenen Kammern; eine zufällig bestimmte Person erhält den Schlüssel.
4. Wer den Schlüssel hat, öffnet eine Kammer bei einer Mitspielerin/einem Mitspieler – alle können und sollen dabei laut diskutieren und bluffen, die Entscheidung trifft aber immer die Person mit dem Schlüssel.
5. Nach so vielen Öffnungen wie Spieler teilnehmen endet die Runde, die restlichen Kammern werden neu gemischt und mit 1 Karte weniger pro Person neu ausgeteilt (max. 4 Runden).
6. Das Spiel endet sofort, sobald alles Gold gefunden ist (Abenteurer gewinnen), alle Feuerfallen aufgedeckt sind (Wächterinnen gewinnen) oder nach 4 Runden nicht alles Gold gefunden wurde (Wächterinnen gewinnen). Danach werden alle wahren Rollen aufgedeckt.
7. Der Host kann direkt eine neue Runde mit denselben Spielern starten.

Viel Spaß beim Spielen – und Vorsicht, wem ihr vertraut. 🗿
