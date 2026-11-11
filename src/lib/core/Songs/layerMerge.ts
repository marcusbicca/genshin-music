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
 *
 * `isFree(key)` says whether the destination is still free there (no note at that moment): a moved
 * note takes the nearest FREE candidate of its kind, and lands on a taken one only when every one is
 * taken. Without it an octave doubling - G5 with G6 above it, the G6 on a layer of its own because
 * the destination stops at B5 - folded straight onto the G5 already there and vanished; it now goes
 * to G4, and the chord keeps two Gs. A note that is ALREADY playable stays put either way: landing
 * on its own twin is a true duplicate.
 *
 * Null when `keys` is empty (nothing can be played there).
 */
export function fitToKeys(
    value: number,
    keys: readonly number[],
    isFree: (key: number) => boolean = () => true
): FittedNote | null {
    if (keys.length === 0) return null
    if (keys.includes(value)) return { value, move: 'kept' }
    const byDistance = (candidates: readonly number[]) =>
        [...candidates].sort((a, b) => Math.abs(a - value) - Math.abs(b - value) || a - b)
    const pick = (candidates: readonly number[]) => {
        const ordered = byDistance(candidates)
        return ordered.find(isFree) ?? ordered[0]
    }
    const sameClass = keys.filter((key) => (((key - value) % 12) + 12) % 12 === 0)
    if (sameClass.length > 0) return { value: pick(sameClass), move: 'octave' }
    return { value: pick(keys), move: 'pitch' }
}

/**
 * `value` (no key of `keys`) moved by whole octaves to between the lowest key and the highest: the
 * nearest FREE such octave, else the nearest one. Strictly between, because a note with no key
 * plays as a key next to it (the importer snaps it), and past the edge that key does not exist;
 * and only where `canHold` says the destination keeps it. A range narrower than an octave may have
 * no room for this pitch class at all: null, and the caller takes the nearest key instead.
 */
function intoRangeByOctaves(
    value: number,
    keys: readonly number[],
    isFree: (value: number) => boolean,
    canHold: (value: number) => boolean
): number | null {
    const low = Math.min(...keys), high = Math.max(...keys)
    const candidates: number[] = []
    for (let moved = value - 12 * Math.ceil((value - low) / 12); moved < high; moved += 12) {
        if (moved > low && canHold(moved)) candidates.push(moved)
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => Math.abs(a - value) - Math.abs(b - value) || a - b)
    return candidates.find(isFree) ?? candidates[0]
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
    /**
     * Landed on a note the destination (or another moved note) already has at that slot, every
     * free octave being taken: these notes disappear into the one already there.
     */
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
    policy: MissingKeyPolicy = 'nearest',
    destination: {
        /**
         * The identity the destination STORES a value as. The composer stores every number as it
         * is; the importer stores a note no key of the layer matches on a button number, so two
         * different values can become one note there. Two notes collide when these agree.
         */
        identity?: (value: number) => number
        /**
         * Whether the destination can hold a value that is none of its keys at all. The composer
         * holds any (a Stranded Note); the importer throws away one it cannot place on a button,
         * so 'keep' must not send a note there.
         */
        canHold?: (value: number) => boolean
        /** Notes this many slots apart still meet (the importer's slots are chord tolerances). */
        slotRadius?: number
    } = {}
): MergePlan {
    const identity = destination.identity ?? ((value: number) => value)
    const canHold = destination.canHold ?? (() => true)
    const stats: MergeStats = { kept: 0, octave: 0, pitch: 0, merged: 0 }
    const landed = new Set<string>()
    let cost = 0
    const radius = destination.slotRadius ?? 0
    const taken = (slot: number, value: number) => {
        if (occupied(slot, value)) return true
        for (let near = slot - radius; near <= slot + radius; near++) {
            if (landed.has(`${near}:${identity(value)}`)) return true
        }
        return false
    }
    const land = (slot: number, value: number) => {
        if (taken(slot, value)) {
            stats.merged++
            cost += MERGED_COST
        }
        landed.add(`${slot}:${identity(value)}`)
        return value
    }
    const values = notes.map((note) => {
        const fit = fitToKeys(note.value, keys, (key) => !taken(note.slot, key))
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
            //kept as it is, but inside the destination's range: a note past it would be thrown away
            //as out of range by the importer, or sit off the composer's grid - the octave is the
            //one thing that may move, so the note stays itself and stays visible
            if (policy === 'keep') {
                const value = intoRangeByOctaves(
                    note.value,
                    keys,
                    (value) => !taken(note.slot, value),
                    canHold
                )
                //no octave of it fits a range this narrow: past the range it would be thrown away
                //(or sit off the grid), so it takes the nearest key after all - changed, not lost
                return land(note.slot, value ?? fit.value)
            }
        }
        return land(note.slot, fit.value)
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
