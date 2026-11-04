# MIDI import plus — notas de passagem (handoff)

Branch: `midi-import-plus` no fork `marcusbicca/genshin-music`.
Objetivo: deixar o importador de MIDI do Sky Music Nightly bom o suficiente pra adaptar músicas
(medleys de anime, arranjos orquestrais) com pouca edição manual. Se ficar bom, abrir PR pro
`Specy/genshin-music`.

Este arquivo resume o que foi descoberto numa sessão longa no Claude (chat), pra continuar no
Claude Code sem perder contexto.

---

## 1. Como o app grava as notas (descoberto lendo o código)

- **Número da nota = som da tecla + deslocamento da escala do layer.**
  `number = sounding(button) + offset(pitch)`, com `offset`: C=0, Db=1 … B=11
  (`src/lib/core/Songs/noteIds.ts`). Ou seja, as escalas **sobem** a partir de C.
- **Cada instrumento tem a sua faixa** (`register` no `meta.json` de cada instrumento em
  `src/lib/games/sky/instruments/*`, presets em `presets.json`). Com escala C:

  | Faixa                   | Instrumentos                                                                                                            |
  | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
  | C4–C6                   | Piano, GrandPiano, Violin, Trumpet, Flute, TransverseFlute, Panflute, Ocarina, MantaOcarina, Harmonica, Aurora, Kalimba |
  | C3–C5                   | Guitar, LightGuitar, Harp, Saxophone, Pipa, ToyUkulele                                                                  |
  | C2–C4                   | Cello, Horn                                                                                                             |
  | C1–C3                   | Contrabass                                                                                                              |
  | C5–C7                   | WinterPiano, Xylophone                                                                                                  |
  | 8 teclas não diatônicas | Bells, SmallBell (C D G A C D G A), HandPan/TriumphHandPan (D3…)                                                        |
  | KrillHorn               | 8 teclas a partir de F3                                                                                                 |

- **Percussão** (DunDun, Drum: 8 teclas C4–C5; FortuneDrum, Cymbals: 4 teclas C–F) também segue
  a escala do layer (o deslocamento vale pra ela também).
- **Nome do instrumento no JSON é o id da pasta**, sem espaço: `WinterPiano`, `GrandPiano`,
  `FortuneDrum`, `TransverseFlute`, `KrillHorn`, `SmallBell`, `ToyUkulele`, `MantaOcarina`,
  `LightGuitar`, `TriumphHandPan`. Nome errado → o app cai no instrumento padrão (Piano) e as
  notas parecem "fora do mapa".
- **Colunas de tempo** (`columnTempos`): 0 = 1, 1 = 1/2, 2 = 1/4, 3 = 1/8 da duração da coluna
  (`game.json` → `composer.tempoChangers`). 1 coluna inteira = 1 batida do `bpm` do arquivo;
  na prática usa-se bpm = BPM da semínima × 4 (coluna = semicolcheia).
- Formato `.skysheet.json` v5 (composto): `tracks[].notes = [coluna, número, duração?]`,
  `tracks[].instrument = {name, volume, pitch ('' = escala da música), alias, ...}`,
  `breakpoints`, `columnTempos`. Campos `songNotes`/`pitchLevel` são legado (Sky Studio).

## 2. O que o Marcus quer (preferências levantadas)

- **Cada layer na escala/oitava que cabe mais notas** — não seguir cegamente o tom do MIDI;
  o app adapta tudo nas mesmas 15 teclas, o que muda é a escala de cada layer.
- **Uma layer por track do MIDI**, instrumento pelo programa GM. Ex.: _Minato saves Kushina_
  ficou perfeito com Violin, Violin, Pipa, Pipa (violões → **Pipa**, não Guitar/ToyUkulele).
- Melodia **não pode pular de oitava no meio da frase**: se precisar mudar de oitava, muda a
  frase inteira.
- Notas rápidas (fusas, tercinas, apojaturas) **não podem se juntar** na mesma coluna → usar
  colunas 1/2, 1/4, 1/8.
- Medleys precisam ser **separados por música** (mudança de tom + tempo).
- Percussão: mapear bumbo/caixa/pratos pras teclas certas e **nunca passar das 8 (ou 4) teclas**.
  Descrição dele do DunDun (posições C D E F G A B C): C e E = tambores que se complementam,
  D = caixa (oco), G = repique (oco), A = chocalho, F/B/C agudo = pratos.

## 3. O que já está nesta branch

- `suggestTrackFit` (`src/lib/core/Songs/midiImport.ts`): pra cada track, testa as 12 escalas ×
  oitavas −4..+4 e escolhe a que deixa mais notas tocáveis (sem acidente, sem nota fora). Só
  move oitavas inteiras; empate → escala da música e menor deslocamento.
- `detectMidiSections` (`src/lib/core/Songs/midiSections.ts`): divide medleys em mudanças de
  tom e de tempo que se mantêm (ignora ritardando/transição curta).
- `MidiParser.svelte`: seletor **Seção** (importa um trecho com o próprio BPM e escala,
  seleciona só as tracks que tocam nele) e botão **Auto fit** (também roda sozinho ao abrir um
  MIDI que não foi exportado pelo app).
- Testes: `test/midiAutoFit.test.ts`.
- Só no fork (não mandar pro upstream): `.github/workflows/pagesBeta.yml` e a env
  `PAGES_BASE_PATH` em `scripts/buildApp.js` → publica o app no GitHub Pages
  (`https://marcusbicca.github.io/genshin-music/`). Precisa ativar em
  Settings → Pages → Source: **GitHub Actions**.

## 4. Feito na rodada de 2026-11-04 (antes "pendências")

A branch foi atualizada com o `upstream/main` do Specy (merge, sem reescrever histórico).
Tudo abaixo fica em `src/lib/core/Songs/midiLayerPlan.ts` (lógica pura, testada em
`test/midiLayerPlan.test.ts`) e é ligado em `MidiParser.svelte`. Os dois toggles novos vêm
**ligados** pra MIDI de fora e **desligados** pra MIDI exportado pelo próprio app (que já traz as
layers dele).

1. **Layers extras pras notas que não cabem** (toggle "Extra layers for notes that do not fit"):
   cada track fica com a layer principal (escala/oitava do Auto fit). O que ela não toca vai pra
   layers extras escolhidas de forma gulosa: a cada passo, a (instrumento, escala) que pega mais
   notas restantes, até acabar ou bater no limite de layers da música (`BASE_LAYER_LIMIT`, que
   garante primeiro a layer principal de cada track). Empate → a escala principal primeiro, e
   dentro da escala o próprio instrumento antes da extensão. O que nenhuma layer toca fica na
   principal e segue os toggles de acidentes/fora do alcance como antes. As layers extras ganham o
   nome `Track (Eb)` ou `Track (WinterPiano)`, e a track mostra `+N layers` na lista.
2. **Frases inteiras de oitava** (toggle "Move whole phrases between octaves"): frase = notas até
   uma pausa de 1 semínima; só a frase que tem nota fora do alcance se move, pelo deslocamento
   (0, ±1 ou ±2 oitavas) que deixa mais notas dentro (empate → o menor). O alcance considerado
   inclui o instrumento de extensão. O `maxScaling` por nota continua existindo (padrão 0).
3. **Piano → WinterPiano**: declarado na config, `midiImport.rangeExtensions` em
   `src/lib/games/sky/instruments/Piano/meta.json`. O importador não cita nenhum instrumento nem
   jogo. Outra extensão é só adicionar o campo em outro `meta.json`.
4. ~~Violão → Pipa~~: descartado (quem escolhe o instrumento é o usuário).
5. **Percussão GM (canal 10)**: `midiImport.percussionMap` (+ `percussionAccents` pras batidas
   soltas) no `meta.json` do DunDun e do Drum do Sky, com a tabela do protótipo (bumbo → C, caixa
   → D, caixa solta → D+E+G+B, tom grave → E, tom agudo/conga → G, condução → F, chimbal etc. → A,
   triângulo/woodblock → B, crash → C agudo). Uma track de bateria cujo instrumento tem mapa é
   colocada tecla por tecla (sem escala/oitava/offset) e nunca passa das teclas do instrumento;
   batidas de notas GM fora do mapa são descartadas e contadas ("N hits with no key"). Diferença
   do protótipo: tudo vai pro instrumento escolhido na track (o protótipo mandava chimbal/triângulo
   pro Drum separado); no DunDun a tecla A já é o chocalho.
6. **Juntar seções**: com uma seção escolhida aparece "Until section", que estende o trecho até
   uma seção seguinte (tempo e tom da primeira) — `mergeSectionRange` em `midiSections.ts`.
7. **i18n `pt`**: todas as strings do importador traduzidas em `static/locales/pt.json` (100%);
   `static/locales/en.json` regenerado.

Config: o schema ganhou o campo opcional `midiImport` (`schema.ts`, `types.ts`, validado em
`registry.ts`). O fixture vivo `test/fixtures/Sky/config-surface-v2.json` foi regenerado (só
adições); o congelado não muda.

### Ainda não feito (estava só no protótipo)

- Juntar tracks do mesmo programa em MIDIs orquestrais grandes (pra caber no limite de layers).
- Adivinhar o instrumento pelo nome da track quando o MIDI não traz programa.

## 5. Protótipo em Python

`docs/midi-import-plus/midi2sky.py` — conversor standalone MIDI → `.skysheet.json` usado na
sessão (One Piece Epic Medley, 20 MIDIs de Naruto). Tem: tabela real de teclas (`SKY_KEYS`),
fit por layer, escala extra, dobra por frase, "spill" pra outro instrumento, colunas 1/2–1/8,
mapa de percussão, detecção de medley. Modo `auto --mode tracks` = uma layer por track.
Serve de referência de algoritmo; a implementação "de verdade" deve ficar no app (TypeScript).

## 6. Rodando

```bash
# Node >= 24.18
npm ci
npm run dev:sky                 # dev server
npm run check:sky               # svelte-check
PUBLIC_GAME=sky npx vitest run test/midiAutoFit.test.ts test/midiRoundTrip.test.ts
PAGES_BASE_PATH=/genshin-music npm run build:sky   # build igual ao do Pages
```
