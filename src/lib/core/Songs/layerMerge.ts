// Folding one layer into another while keeping every note PLAYABLE there.
//
// A layer the MIDI importer adds to reach notes its track's own layer cannot play (another scale,
// another octave) often holds notes whose PITCH CLASS the other layers of its group already have,
// just in another octave. Playing in Sky, fewer layers is better, so the composer and the importer
// can merge such a layer into another one: each note moves to the nearest key the destination can
// play - the same note an octave or two away when the destination has it, the nearest semitone
// only when it does not - and the source layer goes away.
//
// Pure arithmetic on one numeric axis (a song's Note Numbers, or a MIDI file's note numbers with
// the importer's own playability test), so both callers share it and vitest can pin it.

/** What happened to a note on its way into the destination layer. */
export type FitMove = 'kept' | 'octave' | 'pitch'

export type FittedNote = { value: number; move: FitMove }

/**
 * The key of `keys` (the destination's playable values, any order) a note of `value` lands on:
 * itself when playable; else the same pitch class at the nearest octave; else the nearest key at
 * all. Ties go to the lower key, so the answer never depends on the order `keys` came in.
 * Null when `keys` is empty (nothing can be played there).
 */
export function fitToKeys(value: number, keys: readonly number[]): FittedNote | null {
    if (keys.length === 0) return null
    if (keys.includes(value)) return { value, move: 'kept' }
    const closest = (candidates: readonly number[]) =>
        candidates.reduce((best, key) => {
            const d = Math.abs(key - value), bd = Math.abs(best - value)
            return d < bd || (d === bd && key < best) ? key : best
        })
    const sameClass = keys.filter((key) => (((key - value) % 12) + 12) % 12 === 0)
    if (sameClass.length > 0) return { value: closest(sameClass), move: 'octave' }
    return { value: closest(keys), move: 'pitch' }
}

/** One note of the source layer: where it sits in time (a column, a tick) and its value. */
export type MergeSourceNote = { slot: number; value: number }

export type MergeStats = {
    /** Already playable on the destination: unchanged. */
    kept: number
    /** Moved by whole octaves: same note, another register. */
    octave: number
    /** Moved to another note: the destination has no key of this pitch class. */
    pitch: number
    /** Landed on a note the destination (or another moved note) already has at that slot. */
    merged: number
}

export type MergePlan = {
    /** The new value of each source note, in the order given; null when it is dropped. */
    values: (number | null)[]
    stats: MergeStats
    /** Lower is better: a change of note costs far more than a change of octave. */
    cost: number
}

/** A change of note is a change of the music; an octave is a change of register. */
const PITCH_COST = 100
const OCTAVE_COST = 1
const MERGED_COST = 0.5

/**
 * What happens to a note whose pitch class the destination has no key for:
 * - 'nearest' moves it to the nearest key (another note),
 * - 'keep' leaves its number alone, so it lands unplayable (a Stranded Note: dimmed and silent in
 *   the composer, there to be reviewed, then fixed or deleted),
 * - 'drop' deletes it.
 */
export type MissingKeyPolicy = 'nearest' | 'keep' | 'drop'

/**
 * Where each note of a layer goes when merged into a destination whose playable keys are `keys`,
 * with `occupied(slot, value)` telling which notes the destination already has. Nothing is
 * mutated: the caller applies `values`.
 */
export function planLayerMerge(
    notes: readonly MergeSourceNote[],
    keys: readonly number[],
    occupied: (slot: number, value: number) => boolean,
    policy: MissingKeyPolicy = 'nearest'
): MergePlan {
    const stats: MergeStats = { kept: 0, octave: 0, pitch: 0, merged: 0 }
    const landed = new Set<string>()
    let cost = 0
    const values = notes.map((note) => {
        const fit = fitToKeys(note.value, keys)
        if (fit === null) {
            stats.pitch++
            cost += PITCH_COST * 2
            return null
        }
        stats[fit.move]++
        if (fit.move === 'octave') cost += (OCTAVE_COST * Math.abs(fit.value - note.value)) / 12
        if (fit.move === 'pitch') {
            //the cost of the CHOICE of destination does not depend on the policy: a missing key is
            //a loss whatever is done with the note, so the suggestion stays the same
            cost += PITCH_COST + Math.abs(fit.value - note.value)
            if (policy === 'drop') return null
            if (policy === 'keep') return note.value
        }
        const key = `${note.slot}:${fit.value}`
        if (occupied(note.slot, fit.value) || landed.has(key)) {
            stats.merged++
            cost += MERGED_COST
        }
        landed.add(key)
        return fit.value
    })
    return { values, stats, cost }
}

/**
 * The destination to suggest among `candidates` (each with its plan): the cheapest one, ties to
 * the first given - callers list the source's own group first, so a scale layer goes home to its
 * track before it goes anywhere else. Undefined when there is no candidate.
 */
export function suggestMergeTarget<T extends { plan: MergePlan }>(candidates: readonly T[]): T | undefined {
    return candidates.reduce<T | undefined>(
        (best, candidate) => (best === undefined || candidate.plan.cost < best.plan.cost ? candidate : best),
        undefined
    )
}
