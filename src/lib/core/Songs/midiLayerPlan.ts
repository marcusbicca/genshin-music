// Per-track layer planning for the MIDI importer: what happens to ONE MIDI track between "its
// notes" and "the layers it becomes". Three steps, each optional and each pure:
//
//  1. mapPercussionNotes - a General MIDI drum track (channel 10) is not pitched: its note numbers
//     name drums. An instrument that declares a percussionMap in its meta.json takes each GM key
//     onto its own buttons, so a drum track never lands outside the instrument's 8 (or 4) keys.
//
//  2. foldPhrases - a passage the instrument cannot reach moves by whole octaves AS A PHRASE (a run
//     of notes with no rest of a quarter note or more), never note by note: a melody must not jump
//     octave in the middle of a phrase.
//
//  3. planTrackLayers - the track keeps one main layer at its fitted scale; the notes that layer
//     cannot play (accidentals, or notes past its range) go to auxiliary layers of the same
//     instrument at another scale, or of an instrument that declares itself a range extension
//     (Sky's WinterPiano continues Piano). Each auxiliary layer is the candidate that takes the
//     most remaining notes, so the track ends with as few layers as possible.
//
// Capability comes from instrument config (midiImport in meta.json), never from a game id.
import {INSTRUMENTS, INSTRUMENTS_DATA, type Pitch} from '$core/legacyConfig'
import {midiNoteFitsLayer} from './midiImport'
import {basepointOffset, buttonToNumber, getSoundingTable} from './noteIds'
import {planLayerMerge, suggestMergeTarget, type MergeStats, type MissingKeyPolicy} from './layerMerge'

export type PlanNote = {midi: number; time: number; duration: number}

function instrumentData(instrumentName: string) {
    return INSTRUMENTS_DATA[instrumentName as keyof typeof INSTRUMENTS_DATA]
        ?? INSTRUMENTS_DATA[INSTRUMENTS[0]]
}

/** Instruments this one may hand its out-of-range notes to (meta.json midiImport.rangeExtensions). */
export function rangeExtensionsOf(instrumentName: string): readonly string[] {
    return instrumentData(instrumentName).midiImport?.rangeExtensions ?? []
}

/** Whether the instrument can take a GM drum track key by key (meta.json midiImport.percussionMap). */
export function hasPercussionMap(instrumentName: string): boolean {
    const map = instrumentData(instrumentName).midiImport?.percussionMap
    return map !== undefined && Object.keys(map).length > 0
}

// ---- 1. percussion --------------------------------------------------------------------------

export type PercussionMapResult = {
    /** `midi` here is the final Note Number of the button hit (import it with `direct: true`). */
    notes: PlanNote[]
    /** Hits whose GM key the instrument's map does not name. */
    unmapped: number
}

/**
 * Map a GM drum track onto the instrument's buttons. A hit with no other accented-kind hit within
 * `isolationSeconds` (an eighth note) uses the instrument's percussionAccents entry when it has one
 * - a fuller cluster for a lone snare accent - and the plain map inside rolls and fast figures.
 */
export function mapPercussionNotes(
    notes: readonly PlanNote[],
    instrumentName: string,
    pitch: Pitch,
    isolationSeconds: number
): PercussionMapResult {
    const hints = instrumentData(instrumentName).midiImport
    const map = hints?.percussionMap ?? {}
    const accents = hints?.percussionAccents ?? {}
    const accentTimes = notes
        .filter(note => accents[String(note.midi)] !== undefined)
        .map(note => note.time)
        .sort((a, b) => a - b)
    const isIsolated = (time: number) => {
        // the note itself is in the list once; any OTHER hit inside the window makes it a roll
        let near = 0
        for (const other of accentTimes) {
            if (Math.abs(other - time) < isolationSeconds - 1e-6) near++
            if (near > 1) return false
        }
        return true
    }
    const out: PlanNote[] = []
    let unmapped = 0
    for (const note of notes) {
        const key = String(note.midi)
        const accent = accents[key]
        const buttons = accent !== undefined && isIsolated(note.time) ? accent : map[key]
        if (buttons === undefined) {
            unmapped++
            continue
        }
        for (const button of new Set(buttons)) {
            const number = buttonToNumber(instrumentName, pitch, button)
            if (number === null) continue
            out.push({midi: number, time: note.time, duration: note.duration})
        }
    }
    return {notes: out, unmapped}
}

// ---- 2. phrase folding ----------------------------------------------------------------------

export type PhraseFoldOptions = {
    /** The track's instrument first, then any range extensions the plan may use. */
    instruments: readonly string[]
    pitch: Pitch
    /** The offset the importer subtracts from every file pitch (track's own, else the global). */
    localOffset: number
    /** A rest at least this long (seconds) starts a new phrase. */
    phraseGapSeconds: number
    /** Largest move, in octaves, a phrase may make. */
    maxOctaves: number
}

export type PhraseFoldResult = {
    notes: PlanNote[]
    /** Phrases moved by a nonzero number of octaves. */
    movedPhrases: number
}

/**
 * A phrase is moved only when the move brings back at least this share of its notes. A long
 * accompaniment line that strays out of range for a few notes stays where it is (those notes are
 * the out-of-range toggle's business): moving all of it an octave to save a handful lifted a bass
 * line into the melody's octave, where it doubled the other parts of the same instrument.
 */
const MIN_PHRASE_GAIN = 0.25

/**
 * Move every phrase that does not fit by the whole-octave shift that brings the most of its notes
 * inside the instruments' range (ties: the smallest move, no move first), when that saves enough of
 * the phrase (MIN_PHRASE_GAIN). Phrases that already fit are untouched, so a track the fit placed
 * well comes back unchanged.
 *
 * Phrases are split at RESTS - silence between the end of every sounding note and the next start -
 * not at the distance between note starts: a melody of quarter notes has no rest, and splitting it
 * start to start made every note its own phrase, moved octave by octave on its own.
 */
export function foldPhrases(notes: readonly PlanNote[], options: PhraseFoldOptions): PhraseFoldResult {
    const ranges = options.instruments.map(name => {
        const table = getSoundingTable(name)
        const offset = basepointOffset(options.pitch)
        return {min: Math.min(...table) + offset, max: Math.max(...table) + offset}
    })
    const inRange = (midi: number) => {
        const sounding = midi - options.localOffset
        return ranges.some(range => sounding >= range.min && sounding <= range.max)
    }
    const sorted = [...notes].sort((a, b) => a.time - b.time)
    const phrases: PlanNote[][] = []
    let soundingUntil = -Infinity
    for (const note of sorted) {
        //a tiny tolerance: a note that ends exactly where the next starts leaves no rest
        if (phrases.length === 0 || note.time - soundingUntil >= options.phraseGapSeconds - 1e-6) phrases.push([])
        phrases[phrases.length - 1].push(note)
        soundingUntil = Math.max(soundingUntil, note.time + Math.max(0, note.duration))
    }
    const shifts = [0]
    for (let octave = 1; octave <= Math.max(0, Math.floor(options.maxOctaves)); octave++) {
        shifts.push(-12 * octave, 12 * octave)
    }
    const out: PlanNote[] = []
    let movedPhrases = 0
    for (const phrase of phrases) {
        let best = 0
        const fitting = (shift: number) =>
            phrase.reduce((total, note) => total + (inRange(note.midi + shift) ? 1 : 0), 0)
        const here = fitting(0)
        if (here < phrase.length) {
            let bestCount = here
            for (const shift of shifts) {
                const count = fitting(shift)
                if (count > bestCount) {
                    bestCount = count
                    best = shift
                }
            }
            if (bestCount - here < Math.max(1, phrase.length * MIN_PHRASE_GAIN)) best = 0
        }
        if (best !== 0) movedPhrases++
        for (const note of phrase) out.push(best === 0 ? note : {...note, midi: note.midi + best})
    }
    return {notes: out, movedPhrases}
}

// ---- 3. auxiliary layers --------------------------------------------------------------------

export type PlannedLayer = {
    instrumentName: string
    pitch: Pitch
    /** 'main' is the track's own layer; it also keeps every note no auxiliary layer could take. */
    role: 'main' | 'auxiliary'
    notes: PlanNote[]
}

export type TrackLayerPlanOptions = {
    instrumentName: string
    /** The main layer's effective scale (Basepoint). */
    pitch: Pitch
    /** The offset the importer subtracts from every file pitch for this track. */
    localOffset: number
    /** Scales to try for auxiliary layers. */
    pitches: readonly Pitch[]
    /** Instruments that extend this one's range (rangeExtensionsOf). */
    extensions: readonly string[]
    /** How many auxiliary layers this track may still add (the song's layer limit is shared). */
    maxAuxiliaryLayers: number
}

/**
 * Greedy cover: the main layer keeps what it plays; then, while notes remain and the budget lasts,
 * add the (instrument, scale) layer that plays the most remaining notes. Candidates are tried in a
 * fixed order - the main scale before the others, and within a scale the track's own instrument
 * before its extensions - and only a strictly better count replaces the best so far, so ties stay predictable.
 */
export function planTrackLayers(notes: readonly PlanNote[], options: TrackLayerPlanOptions): PlannedLayer[] {
    const fits = (note: PlanNote, instrumentName: string, pitch: Pitch) =>
        midiNoteFitsLayer(note.midi, instrumentName, pitch, options.localOffset)
    const main: PlannedLayer = {instrumentName: options.instrumentName, pitch: options.pitch, role: 'main', notes: []}
    let remaining: PlanNote[] = []
    for (const note of notes) {
        if (fits(note, options.instrumentName, options.pitch)) main.notes.push(note)
        else remaining.push(note)
    }
    const layers: PlannedLayer[] = [main]
    const scales = [options.pitch, ...options.pitches.filter(pitch => pitch !== options.pitch)]
    const instruments = [options.instrumentName, ...options.extensions.filter(name => name !== options.instrumentName)]
    let budget = Math.max(0, Math.floor(options.maxAuxiliaryLayers))
    while (remaining.length > 0 && budget > 0) {
        let best: {instrumentName: string; pitch: Pitch; taken: PlanNote[]} | null = null
        // scales outermost: on a tie the main scale wins even on an extension instrument, so notes
        // past the range continue the same key (Piano -> WinterPiano at C) before any rescaling
        for (const pitch of scales) {
            for (const instrumentName of instruments) {
                // the main layer itself already took everything it can
                if (instrumentName === options.instrumentName && pitch === options.pitch) continue
                const taken = remaining.filter(note => fits(note, instrumentName, pitch))
                if (taken.length > (best?.taken.length ?? 0)) best = {instrumentName, pitch, taken}
            }
        }
        if (best === null) break
        const taken = new Set(best.taken)
        layers.push({instrumentName: best.instrumentName, pitch: best.pitch, role: 'auxiliary', notes: best.taken})
        remaining = remaining.filter(note => !taken.has(note))
        budget--
    }
    // whatever no layer can play stays on the main layer, where the accidental and out-of-range
    // toggles decide its fate exactly as they did before auxiliary layers existed
    main.notes.push(...remaining)
    return layers
}

// ---- 4. folding extra layers ----------------------------------------------------------------

/** One extra layer of a track as the importer's track row lists it, with its fold options. */
export type FoldListing = {
    /** Stable while the plan holds: instrument and scale ('Piano@Eb'); 'main' is the track's own. */
    key: string
    instrumentName: string
    pitch: string
    notes: number
    options: {key: string; instrumentName: string; pitch: string; stats: MergeStats}[]
    suggested: string | null
}

export function plannedLayerKey(layer: PlannedLayer): string {
    return layer.role === 'main' ? 'main' : `${layer.instrumentName}@${layer.pitch}`
}

/**
 * THE USER'S FOLDS of a track's extra layers: `merges` maps an extra layer's key to the key of the
 * layer it goes into. Each folded layer's notes move onto the keys its destination can play
 * (layerMerge.ts) - the same note in another octave when it has it, else as `policy` says - and
 * the layer is not created. Folds are applied in plan order and follow a chain (a into b, b into
 * the main layer) to wherever it ends; a key the plan no longer has is ignored.
 *
 * `keysOf` answers what a layer can play, as MIDI numbers of this track. The listing is built
 * from the plan as the planner made it, so its options do not depend on the folds chosen.
 */
export function foldPlannedLayers(
    plan: readonly PlannedLayer[],
    merges: Readonly<Record<string, string>>,
    options: {keysOf: (layer: PlannedLayer) => readonly number[]; policy: MissingKeyPolicy}
): {layers: PlannedLayer[]; listing: FoldListing[]} {
    const keysCache = new Map<string, readonly number[]>()
    const keysOf = (layer: PlannedLayer) => {
        const key = plannedLayerKey(layer)
        if (!keysCache.has(key)) keysCache.set(key, options.keysOf(layer))
        return keysCache.get(key) as readonly number[]
    }
    const slot = (time: number) => Math.round(time * 1000)
    const planInto = (source: PlannedLayer, target: PlannedLayer) => {
        const occupied = new Set(target.notes.map((note) => `${slot(note.time)}:${note.midi}`))
        return planLayerMerge(
            source.notes.map((note) => ({slot: slot(note.time), value: note.midi})),
            keysOf(target),
            (at, value) => occupied.has(`${at}:${value}`),
            options.policy
        )
    }
    //whether following the chosen folds from `key` comes back to `to`: such a destination would
    //close a loop (a into b, b into a), so it is not offered - nor suggested - to `to`
    const reaches = (key: string, to: string) => {
        const seen = new Set<string>()
        let current: string | undefined = key
        while (current !== undefined && !seen.has(current)) {
            if (current === to) return true
            seen.add(current)
            current = merges[current]
        }
        return false
    }
    const listing = plan
        .filter((layer) => layer.role === 'auxiliary')
        .map((layer) => {
            const candidates = plan
                .filter((other) => other !== layer && !reaches(plannedLayerKey(other), plannedLayerKey(layer)))
                .map((other) => ({
                    key: plannedLayerKey(other),
                    instrumentName: other.instrumentName,
                    pitch: other.pitch as string,
                    plan: planInto(layer, other),
                }))
            const suggested = suggestMergeTarget(candidates)
            return {
                key: plannedLayerKey(layer),
                instrumentName: layer.instrumentName,
                pitch: layer.pitch as string,
                notes: layer.notes.length,
                options: candidates.map(({plan: merge, ...rest}) => ({...rest, stats: merge.stats})),
                suggested: suggested?.key ?? null,
            }
        })
    //the folds themselves, on copies: the plan's note arrays are the planner's
    const layers = plan.map((layer) => ({...layer, notes: [...layer.notes]}))
    const byKey = new Map(layers.map((layer) => [plannedLayerKey(layer), layer]))
    const folded = new Set<string>()
    const destination = (key: string) => {
        const seen = new Set<string>()
        let current = key
        while (folded.has(current) && !seen.has(current)) {
            seen.add(current)
            current = merges[current]
        }
        return byKey.get(current)
    }
    for (const layer of layers) {
        const key = plannedLayerKey(layer)
        const into = merges[key]
        if (layer.role === 'main' || !into || !byKey.has(into)) continue
        folded.add(key)
        const target = destination(into)
        //a chain that comes back (a into b, b into a) ends on a layer that is itself folded away:
        //pouring the notes there would drop them with it, so this fold is refused and the layer kept
        if (!target || target === layer || folded.has(plannedLayerKey(target))) {
            folded.delete(key)
            continue
        }
        const merge = planInto(layer, target)
        layer.notes.forEach((note, i) => {
            const value = merge.values[i]
            if (value !== null) target.notes.push({...note, midi: value})
        })
    }
    return {layers: layers.filter((layer) => !folded.has(plannedLayerKey(layer))), listing}
}
