// Per-track layer planning for the MIDI importer (midiLayerPlan.ts): phrase octaves, auxiliary
// layers for leftover notes, range extensions, GM percussion mapping - and section ranges.
import {describe, expect, it} from 'vitest'
import {INSTRUMENTS, INSTRUMENTS_DATA, PITCHES} from './imports'
import {importMidiTracks, midiNoteFitsLayer} from '../src/lib/core/Songs/midiImport'
import {
    foldPhrases,
    hasPercussionMap,
    mapPercussionNotes,
    planTrackLayers,
    rangeExtensionsOf,
    type PlanNote,
} from '../src/lib/core/Songs/midiLayerPlan'
import {mergeSectionRange, type MidiSection} from '../src/lib/core/Songs/midiSections'
import {buttonToNumber, getSoundingTable, numberToButton} from '../src/lib/core/Songs/noteIds'

const instrument = INSTRUMENTS[0]
const lowest = Math.min(...getSoundingTable(instrument))
const highest = Math.max(...getSoundingTable(instrument))
/** One note per step, a 16th apart at 120 quarter-bpm (0.125s). */
const line = (midis: number[], start = 0, step = 0.125): PlanNote[] =>
    midis.map((midi, i) => ({midi, time: start + i * step, duration: step}))

describe('planTrackLayers', () => {
    const base = {
        instrumentName: instrument,
        pitch: 'C' as const,
        localOffset: 0,
        pitches: PITCHES,
        extensions: [] as string[],
        maxAuxiliaryLayers: 10,
    }

    it('keeps a track that fits on its main layer alone', () => {
        const notes = line([lowest, lowest + 2, lowest + 4])
        const plan = planTrackLayers(notes, base)
        expect(plan).toHaveLength(1)
        expect(plan[0]).toMatchObject({role: 'main', pitch: 'C'})
        expect(plan[0].notes).toHaveLength(3)
    })

    it('sends accidentals to an extra layer of the same instrument on the scale that takes them', () => {
        // C major plus Eb and Bb: both are naturals of the Eb, Bb and F... scales; one layer suffices
        const notes = line([lowest, lowest + 2, lowest + 3, lowest + 4, lowest + 10])
        const plan = planTrackLayers(notes, base)
        expect(plan).toHaveLength(2)
        expect(plan[0].notes.map(n => n.midi)).toEqual([lowest, lowest + 2, lowest + 4])
        expect(plan[1]).toMatchObject({role: 'auxiliary', instrumentName: instrument})
        expect(plan[1].notes.map(n => n.midi)).toEqual([lowest + 3, lowest + 10])
        for (const note of plan[1].notes) {
            expect(midiNoteFitsLayer(note.midi, instrument, plan[1].pitch, 0)).toBe(true)
        }
    })

    it('adds as few layers as possible: the greedy pick takes the scale covering the most notes', () => {
        // Db, Eb, Gb, Ab, Bb: all five are naturals of the Db (and Gb) major scale - one layer
        const notes = line([lowest + 1, lowest + 3, lowest + 6, lowest + 8, lowest + 10])
        const plan = planTrackLayers(notes, base)
        expect(plan).toHaveLength(2)
        expect(plan[0].notes).toHaveLength(0)
        expect(plan[1].notes).toHaveLength(5)
    })

    it('respects the layer budget, leaving the rest on the main layer', () => {
        const notes = line([lowest, lowest + 1, lowest + 3])
        const plan = planTrackLayers(notes, {...base, maxAuxiliaryLayers: 0})
        expect(plan).toHaveLength(1)
        expect(plan[0].notes).toHaveLength(3)
    })

    it('keeps notes no layer can play on the main layer', () => {
        const notes = line([lowest, highest + 40])
        const plan = planTrackLayers(notes, base)
        expect(plan).toHaveLength(1)
        expect(plan[0].notes.map(n => n.midi)).toEqual([lowest, highest + 40])
    })
})

describe.skipIf(!INSTRUMENTS.includes('WinterPiano' as never))('Piano range extension (Sky)', () => {
    it('is declared in config, not in the importer', () => {
        expect(rangeExtensionsOf('Piano')).toEqual(['WinterPiano'])
        expect(rangeExtensionsOf('WinterPiano')).toEqual([])
    })

    it('sends notes above Piano to a WinterPiano layer on the same scale', () => {
        const pianoTop = Math.max(...getSoundingTable('Piano'))
        const above = [pianoTop + 2, pianoTop + 4, pianoTop + 5] // D6, E6, F6 at C
        const notes = line([pianoTop - 12, pianoTop, ...above])
        const plan = planTrackLayers(notes, {
            instrumentName: 'Piano',
            pitch: 'C',
            localOffset: 0,
            pitches: PITCHES,
            extensions: rangeExtensionsOf('Piano'),
            maxAuxiliaryLayers: 10,
        })
        expect(plan).toHaveLength(2)
        expect(plan[1]).toMatchObject({instrumentName: 'WinterPiano', pitch: 'C', role: 'auxiliary'})
        expect(plan[1].notes.map(n => n.midi)).toEqual(above)
    })
})

describe('foldPhrases', () => {
    const options = {
        instruments: [instrument],
        pitch: 'C' as const,
        localOffset: 0,
        phraseGapSeconds: 0.5,
        maxOctaves: 2,
    }

    it('leaves phrases that fit alone', () => {
        const notes = line([lowest, lowest + 2, lowest + 4])
        const result = foldPhrases(notes, options)
        expect(result.movedPhrases).toBe(0)
        expect(result.notes.map(n => n.midi)).toEqual(notes.map(n => n.midi))
    })

    it('moves a whole phrase by one octave, not just the note that is out', () => {
        // the phrase reaches one note past the top: the whole phrase drops, keeping its shape
        const phrase = [highest - 4, highest - 2, highest, highest + 2]
        const result = foldPhrases(line(phrase), options)
        expect(result.movedPhrases).toBe(1)
        expect(result.notes.map(n => n.midi)).toEqual(phrase.map(m => m - 12))
    })

    it('treats a rest of a quarter note as a phrase boundary', () => {
        const first = line([lowest, lowest + 2])
        const second = line([highest + 2, highest + 4], 2) // starts 2s later, past the gap
        const result = foldPhrases([...first, ...second], options)
        expect(result.movedPhrases).toBe(1)
        expect(result.notes.map(n => n.midi)).toEqual([lowest, lowest + 2, highest - 10, highest - 8])
    })

    it('keeps a quarter-note melody with no rest as one phrase', () => {
        // starts a quarter apart, each note lasting until the next: no rest anywhere
        const melody = line([highest - 4, highest - 2, highest, highest + 2], 0, 0.5)
        const result = foldPhrases(melody, options)
        expect(result.movedPhrases).toBe(1)
        expect(result.notes.map(n => n.midi)).toEqual(melody.map(n => n.midi - 12))
    })

    it('leaves a long line in place when a move would save only a few of its notes', () => {
        // 20 notes in range and 2 above it: moving all 22 down an octave to save 2 is not worth it
        const inside = Array.from({length: 20}, (_, i) => highest - (i % 5))
        const notes = line([...inside, highest + 2, highest + 4])
        const result = foldPhrases(notes, options)
        expect(result.movedPhrases).toBe(0)
        expect(result.notes.map(n => n.midi)).toEqual(notes.map(n => n.midi))
    })

    it('counts the range extensions as reachable', () => {
        const result = foldPhrases(line([highest + 2]), {...options, instruments: [instrument, instrument]})
        expect(result.movedPhrases).toBe(1)
        if (INSTRUMENTS.includes('WinterPiano' as never)) {
            const kept = foldPhrases(line([Math.max(...getSoundingTable('Piano')) + 2]), {
                ...options,
                instruments: ['Piano', 'WinterPiano'],
            })
            expect(kept.movedPhrases).toBe(0)
        }
    })
})

const drum = INSTRUMENTS.find(name => hasPercussionMap(name))

describe.skipIf(drum === undefined)('mapPercussionNotes', () => {
    // describe.skipIf still COLLECTS the body, so nothing here may assume a drum exists
    const name = drum ?? INSTRUMENTS[0]
    const map = INSTRUMENTS_DATA[name as keyof typeof INSTRUMENTS_DATA]?.midiImport ?? {
        rangeExtensions: [],
        percussionMap: {},
        percussionAccents: {},
    }

    it('maps each GM key onto the buttons the instrument names, and nothing past its keys', () => {
        const kick = 36
        const result = mapPercussionNotes(line([kick]), name, 'C', 0.25)
        expect(result.unmapped).toBe(0)
        expect(result.notes.map(n => numberToButton(name, 'C', n.midi))).toEqual(map.percussionMap['36'])
    })

    it('counts GM keys the map does not name, and drops them', () => {
        const result = mapPercussionNotes(line([127]), name, 'C', 0.25)
        expect(result).toEqual({notes: [], unmapped: 1})
    })

    it('uses the accent cluster for a lone hit and the plain key inside a roll', () => {
        const accented = Object.keys(map.percussionAccents)[0]
        if (accented === undefined) return
        const key = Number(accented)
        const lone = mapPercussionNotes(line([key]), name, 'C', 0.25)
        expect(lone.notes.map(n => numberToButton(name, 'C', n.midi))).toEqual(map.percussionAccents[accented])
        const roll = mapPercussionNotes(line([key, key, key], 0, 0.1), name, 'C', 0.25)
        expect(roll.notes).toHaveLength(3)
        expect(new Set(roll.notes.map(n => numberToButton(name, 'C', n.midi)))).toEqual(
            new Set(map.percussionMap[accented])
        )
    })

    it('imports the mapped hits as-is at any scale (direct tracks skip the snap)', () => {
        for (const pitch of ['C', 'Eb'] as const) {
            const mapped = mapPercussionNotes(line([36, 38, 42], 0, 0.5), name, pitch, 0.25)
            const result = importMidiTracks(
                [{notes: mapped.notes, layer: 0, localOffset: 0, maxScaling: 0, direct: true}],
                {bpm: 480, offset: 7, includeAccidentals: false, pitch: 'C', layers: [{name, pitch}]}
            )
            const placed = result.columns.flatMap(column => column.notes.map(note => note.id))
            expect(placed).toEqual(mapped.notes.map(n => n.midi))
            for (const id of placed) expect(numberToButton(name, pitch, id)).not.toBe(-1)
            expect(placed[0]).toBe(buttonToNumber(name, pitch, map.percussionMap['36'][0]))
        }
    })
})

describe('mergeSectionRange', () => {
    const sections: MidiSection[] = [
        {start: 0, end: 30, bpm: 120, key: 'C', minor: false},
        {start: 30, end: 45, bpm: 90, key: 'D', minor: false},
        {start: 45, end: 80, bpm: 140, key: 'E', minor: true},
    ]

    it('joins consecutive sections, keeping the first one tempo and key', () => {
        expect(mergeSectionRange(sections, 0, 1)).toEqual({start: 0, end: 45, bpm: 120, key: 'C', minor: false})
    })

    it('clamps an end before the start or past the last section', () => {
        expect(mergeSectionRange(sections, 1, 0)).toEqual(sections[1])
        expect(mergeSectionRange(sections, 1, 99)?.end).toBe(80)
        expect(mergeSectionRange(sections, 5, 6)).toBeUndefined()
    })
})
