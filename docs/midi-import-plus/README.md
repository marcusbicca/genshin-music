# MIDI import plus — handoff notes

Branch: `midi-import-plus` on the fork `marcusbicca/genshin-music`.
Goal: make Sky Music Nightly's MIDI importer good enough to adapt songs (anime medleys,
orchestral arrangements) with little manual editing. If it works out, open a PR to
`Specy/genshin-music`.

This file summarises what was found during a long Claude (chat) session, so the work can continue
in Claude Code without losing context.

---

## 1. How the app stores notes (found by reading the code)

- **Note number = the button's sound + the layer's scale offset.**
  `number = sounding(button) + offset(pitch)`, with `offset`: C=0, Db=1 … B=11
  (`src/lib/core/Songs/noteIds.ts`). In other words, scales go **up** from C.
- **Every instrument has its own range** (`register` in each instrument's `meta.json` under
  `src/lib/games/sky/instruments/*`, presets in `presets.json`). At scale C:

  | Range               | Instruments                                                                                                             |
  | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
  | C4–C6               | Piano, GrandPiano, Violin, Trumpet, Flute, TransverseFlute, Panflute, Ocarina, MantaOcarina, Harmonica, Aurora, Kalimba |
  | C3–C5               | Guitar, LightGuitar, Harp, Saxophone, Pipa, ToyUkulele                                                                  |
  | C2–C4               | Cello, Horn                                                                                                             |
  | C1–C3               | Contrabass                                                                                                              |
  | C5–C7               | WinterPiano, Xylophone                                                                                                  |
  | 8 non-diatonic keys | Bells, SmallBell (C D G A C D G A), HandPan/TriumphHandPan (D3…)                                                        |
  | KrillHorn           | 8 keys starting at F3                                                                                                   |

- **Percussion** (DunDun, Drum: 8 keys C4–C5; FortuneDrum, Cymbals: 4 keys C–F) also follows the
  layer's scale (the offset applies to it too).
- **The instrument name in the JSON is the folder id**, no spaces: `WinterPiano`, `GrandPiano`,
  `FortuneDrum`, `TransverseFlute`, `KrillHorn`, `SmallBell`, `ToyUkulele`, `MantaOcarina`,
  `LightGuitar`, `TriumphHandPan`. A wrong name makes the app fall back to the default instrument
  (Piano) and the notes look "off the map".
- **Column tempos** (`columnTempos`): 0 = 1, 1 = 1/2, 2 = 1/4, 3 = 1/8 of the column length
  (`game.json` → `composer.tempoChangers`). One whole column = one beat of the file's `bpm`; in
  practice bpm = quarter-note BPM × 4 (a column is a sixteenth note).
- `.skysheet.json` v5 format (composed): `tracks[].notes = [column, number, duration?]`,
  `tracks[].instrument = {name, volume, pitch ('' = the song's scale), alias, ...}`,
  `breakpoints`, `columnTempos`. The `songNotes`/`pitchLevel` fields are legacy (Sky Studio).

## 2. What Marcus wants (gathered preferences)

- **Each layer on the scale/octave that fits the most notes** — don't blindly follow the MIDI's
  key; the app puts everything on the same 15 keys, what changes is each layer's scale.
- **One layer per MIDI track**, instrument from the GM program. E.g. _Minato saves Kushina_ came
  out perfect with Violin, Violin, Pipa, Pipa.
- A melody **must not jump octave in the middle of a phrase**: if it has to change octave, the
  whole phrase changes.
- Fast notes (32nds, triplets, grace notes) **must not merge** into one column → use 1/2, 1/4
  and 1/8 columns.
- Medleys need to be **split per song** (key + tempo change).
- Percussion: map kick/snare/cymbals onto the right keys and **never go past the 8 (or 4) keys**.
  His description of DunDun (positions C D E F G A B C): C and E = drums that complement each
  other, D = snare (hollow), G = high drum (hollow), A = shaker, F/B/high C = cymbals.

## 3. Already on this branch

- `suggestTrackFit` (`src/lib/core/Songs/midiImport.ts`): for each track, tries the 12 scales ×
  octaves −4..+4 and picks the one that leaves the most playable notes (no accidentals, nothing
  out of range). Only moves whole octaves; ties → the song's scale and the smallest move.
- `detectMidiSections` (`src/lib/core/Songs/midiSections.ts`): splits medleys at key and tempo
  changes that hold (ignores ritardandos and short transitions).
- `MidiParser.svelte`: **Section** selector (imports one stretch with its own BPM and scale,
  selecting only the tracks that play in it) and the **Auto fit** button (also runs on its own
  when a MIDI not exported by the app is opened).
- Tests: `test/midiAutoFit.test.ts`.
- Fork only (do not send upstream): `.github/workflows/pagesBeta.yml` and the `PAGES_BASE_PATH`
  env var in `scripts/buildApp.js` → publishes the app on GitHub Pages
  (`https://marcusbicca.github.io/genshin-music/`). Needs Settings → Pages → Source:
  **GitHub Actions**.

## 4. Done in the 2026-11-04 round (formerly "pending")

The branch was brought up to date with Specy's `upstream/main` (a merge, no history rewritten).
Everything below lives in `src/lib/core/Songs/midiLayerPlan.ts` (pure logic, tested in
`test/midiLayerPlan.test.ts`) and is wired up in `MidiParser.svelte`. Both new toggles default
**on** for foreign MIDIs and **off** for MIDIs exported by the app itself (which already carry
their layers).

1. **Extra layers for notes that don't fit** (toggle "Extra layers for notes that do not fit"):
   each track keeps its main layer (the Auto fit scale/octave). What it cannot play goes to extra
   layers picked greedily: at each step, the (instrument, scale) that takes the most remaining
   notes, until none are left or the song's layer limit is reached (`BASE_LAYER_LIMIT`, which
   reserves every track's main layer first). Ties → the main scale first, and within a scale the
   track's own instrument before its extension. Whatever no layer can play stays on the main
   layer and follows the accidental/out-of-range toggles as before. Extra layers are named
   `Track (Eb)` or `Track (WinterPiano)`, and the track shows `+N layers` in the list.
2. **Whole phrases between octaves** (toggle "Move whole phrases between octaves"): a phrase is
   the notes up to a rest of a quarter note; only a phrase with a note out of range moves, by the
   shift (0, ±1 or ±2 octaves) that keeps the most notes inside (ties → the smallest). The range
   includes the extension instrument. The per-note `maxScaling` still exists (default 0).
3. **Piano → WinterPiano**: declared in config, `midiImport.rangeExtensions` in
   `src/lib/games/sky/instruments/Piano/meta.json`. The importer names no instrument and no game.
   Another extension is just the same field in another `meta.json`.
4. **Instrument suggestion from the prototype**: Sky's `game.json` now carries
   `midi.instrumentSuggestions`, the prototype's tables: track-name hints first (ordered: "double
   bass" before "bass", "sax" before "alto"; includes Portuguese names like "violão", "baixo"), then
   `drumKit` (DunDun) for channel-10 tracks, then GM program ranges (guitars 24–31 → Pipa, basses →
   Contrabass, strings → Violin/Cello, ...). Only what the table doesn't answer falls back to GM
   family matching. It is still just the starting pick; the user chooses the final instrument.
5. **GM percussion (channel 10)**: `midiImport.percussionMap` (+ `percussionAccents` for isolated
   hits) in Sky's DunDun and Drum `meta.json`, with the prototype's table (kick → C, snare → D,
   isolated snare → D+E+G+B, low tom → E, high tom/conga → G, ride → F, hi-hat etc. → A,
   triangle/woodblock → B, crash → high C). A drum track whose instrument has a map is placed key
   by key (no scale/octave/offset) and never goes past the instrument's keys; hits of GM keys
   outside the map are dropped and counted ("N hits with no key"). Difference from the prototype:
   everything goes to the track's chosen instrument (the prototype sent hi-hat/triangle to a
   separate Drum layer); on DunDun the A key already is the shaker.
6. **Joined sections**: once a section is picked, "Until section" extends the range over the
   following sections (tempo and key of the first) — `mergeSectionRange` in `midiSections.ts`.
7. **`pt` i18n**: every importer string translated in `static/locales/pt.json` (100%);
   `static/locales/en.json` regenerated.

Config: the schema gained the optional `midiImport` field (`schema.ts`, `types.ts`, validated in
`registry.ts`). The living fixture `test/fixtures/Sky/config-surface-v2.json` was regenerated
(additions only); the frozen one is unchanged.

### Not done yet (prototype only)

- Merge same-program tracks in large orchestral MIDIs (to fit the layer limit).

## 5. Python prototype

`docs/midi-import-plus/midi2sky.py` — standalone MIDI → `.skysheet.json` converter used during the
session (One Piece Epic Medley, 20 Naruto MIDIs). It has: the real key table (`SKY_KEYS`),
per-layer fit, extra scale, phrase folding, "spill" to another instrument, 1/2–1/8 columns, a
percussion map and medley detection. `auto --mode tracks` = one layer per track. It is an
algorithm reference; the real implementation belongs in the app (TypeScript).

## 6. Running

```bash
# Node >= 24.18
npm ci
npm run dev:sky                 # dev server
npm run check:sky               # svelte-check
PUBLIC_GAME=sky npx vitest run test/midiAutoFit.test.ts test/midiLayerPlan.test.ts test/midiRoundTrip.test.ts
PAGES_BASE_PATH=/genshin-music npm run build:sky   # same build as the Pages one
```
