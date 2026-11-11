// layerMerge.ts applied to a composed song: what merging layer `from` into layer `into` would do,
// for the layer panel's "Merge into" preview, and the remap ComposedSong.mergeTrackInto applies.
import type { Pitch } from '$lib/games/types'
import type { InstrumentData, NoteColumn } from './SongClasses'
import { basepointOffset, effectiveTrackPitch, getSoundingTable } from './noteIds'
import { layersInScope } from './layerNames'
import { planLayerMerge, suggestMergeTarget, type MergePlan, type MissingKeyPolicy } from './layerMerge'

/** The Note Numbers a layer can play: its instrument's buttons at its effective Basepoint. */
export function layerKeys(instrument: Pick<InstrumentData, 'name' | 'pitch'>, songPitch: Pitch): number[] {
    const offset = basepointOffset(effectiveTrackPitch(instrument, songPitch))
    return getSoundingTable(instrument.name).map((sounding) => sounding + offset)
}

export type ComposedMergeOption = {
    into: number
    /** The destination is in the source's own group (its track and that track's extension layers). */
    inGroup: boolean
    plan: MergePlan
    /** New number per moved note, keyed `column:number`, for mergeTrackInto's remap. */
    remap: (columnIndex: number, id: number) => number | null
}

export function planComposedMerge(
    columns: readonly NoteColumn[],
    instruments: readonly InstrumentData[],
    songPitch: Pitch,
    from: number,
    into: number,
    inGroup = false,
    policy: MissingKeyPolicy = 'nearest'
): ComposedMergeOption {
    const source: { slot: number; value: number }[] = []
    const occupied = new Set<string>()
    columns.forEach((column, columnIndex) => {
        for (const note of column.notes) {
            if (note.trackIndex === from) source.push({ slot: columnIndex, value: note.id })
            else if (note.trackIndex === into) occupied.add(`${columnIndex}:${note.id}`)
        }
    })
    const plan = planLayerMerge(
        source,
        layerKeys(instruments[into], songPitch),
        (slot, value) => occupied.has(`${slot}:${value}`),
        policy
    )
    const moved = new Map<string, number | null>()
    source.forEach((note, i) => moved.set(`${note.slot}:${note.value}`, plan.values[i]))
    return {
        into,
        inGroup,
        plan,
        remap: (columnIndex, id) => {
            const key = `${columnIndex}:${id}`
            return moved.has(key) ? (moved.get(key) as number | null) : id
        },
    }
}

/**
 * Every layer `from` could merge into, the source's own group first, and the suggested one: the
 * cheapest inside the group when the layer has a group, else the cheapest overall.
 */
export function composedMergeOptions(
    columns: readonly NoteColumn[],
    instruments: readonly InstrumentData[],
    songPitch: Pitch,
    from: number,
    policy: MissingKeyPolicy = 'nearest'
): { options: ComposedMergeOption[]; suggested: ComposedMergeOption | undefined } {
    const group = new Set(layersInScope(instruments, from, 'group', songPitch))
    const order = instruments
        .map((_, index) => index)
        .filter((index) => index !== from)
        .sort((a, b) => Number(group.has(b)) - Number(group.has(a)) || a - b)
    const options = order.map((into) =>
        planComposedMerge(columns, instruments, songPitch, from, into, group.has(into), policy)
    )
    const grouped = options.filter((option) => option.inGroup)
    const suggested = suggestMergeTarget(grouped.length > 0 ? grouped : options)
    return { options, suggested }
}
