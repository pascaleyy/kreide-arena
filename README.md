# Kreide-Arena

Kleines Online-Multiplayer-Spiel für zwischendurch. Ihr werft mit Kreide aufeinander, wer zuerst 10 Leute erwischt oder nach 3 Minuten die meisten hat, gewinnt die Runde. Jede Runde gibt es eine neue Map.

## Steuerung

| Taste | Aktion |
|---|---|
| W A S D | laufen |
| Maus | zielen |
| Linksklick | werfen |
| Leertaste | Sprint |
| E oder Rechtsklick | Schild (wenn eingesammelt) |
| Q | Geistersprint (einmalig, wenn eingesammelt) |

## Regeln

- 3 Minuten pro Runde. Sieg bei 10 Kills oder mit den meisten Kills, wenn die Zeit um ist.
- 5 Maps: Pausenhof, Turnhalle, Labyrinth, Kreuzung, Säulenhalle. Nie zweimal dieselbe hintereinander.
- Map-Größe je nach Spielerzahl: klein (2), mittel (3–4), groß (ab 5).
- Würfe, die von einer Wand oder einem Schild abprallen, machen mindestens 2 Schaden (roter Rand).
- Power-ups gelten nur für die laufende Runde, Waffen verliert man zusätzlich beim Tod:
  Heilung, Extraleben, Schild, Schrotkreide, Schnellfeuer, Riesenkreide, Turbo, Geistersprint.
- Geistersprint: einmal mit Q ein Stück durch Wände sprinten, in Laufrichtung (oder Blickrichtung, wenn du stehst). Man landet immer auf freiem Boden, nie in einer Wand.

## Räume

Jeder spielt standardmäßig im Raum `haupt`. Eigener Raum: Link mit `?raum=name` am Ende, zum Beispiel `https://deine-adresse.onrender.com/?raum=pascal`.

## Online stellen mit Render (kostenlos)

1. Auf [render.com](https://render.com) mit deinem GitHub-Account anmelden.
2. **New +** → **Blueprint** wählen.
3. Das Repo `kreide-arena` auswählen. Render findet die Datei `render.yaml` von selbst.
4. **Apply** klicken und warten, bis der Status **Live** zeigt (ein paar Minuten).
5. Oben steht deine Adresse, etwa `https://kreide-arena.onrender.com`. Die schickst du in Discord.

Der kostenlose Server schläft nach 15 Minuten ohne Spieler ein. Der erste Aufruf danach dauert bis zu einer Minute, dann läuft alles normal.

Jede Änderung, die auf GitHub im Branch `main` landet, wird von Render automatisch neu veröffentlicht.

## Lokal starten

Du brauchst nur [Node.js](https://nodejs.org) (Version 18 oder neuer), sonst keine Pakete.

```
node server.js
```

Dann im Browser `http://localhost:3000` öffnen.

## Aufbau

- `server.js` – Spielserver: berechnet alles (Bewegung, Treffer, Runden, Power-ups) 30-mal pro Sekunde.
- `ws-lite.js` – kleiner eingebauter WebSocket-Teil, damit keine Zusatzpakete nötig sind.
- `shared/game.js` – Regeln und Maps, die Server und Browser beide nutzen.
- `public/` – die Spielseite.
