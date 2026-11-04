// Automatic layer names and layer groups.
//
// A layer is labelled from what it IS - its instrument, its number among the layers of that
// instrument, and its scale when it differs from the song's ("Violin 2", "Piano 1 (Eb)") - when it
// has no typed name, or always when `autoName` is on. The label follows every swap, Basepoint
// change and reorder, so a song arranged by swapping instruments around never carries stale names.
//
// A GROUP is a layer plus the extension layers right below it (`extensionLayer`: the layers the
// MIDI importer adds for the notes a track's own layer cannot play, at another scale or on a range
// extension such as WinterPiano). The layer panel can swap the instrument of a whole group, or set
// its volume, at once. An extension of the same instrument shares its group's number, so
// [Violin, Violin (Eb) extension, Violin] reads "Violin 1", "Violin 1 (Eb)", "Violin 2".
import type {Pitch} from '$lib/games/types'
import type {InstrumentData} from './SongClasses'
import {effectiveTrackPitch} from './noteIds'

export type LayerGroupInfo = {
    instrumentName: string
    /** 1-based number among the layers of this instrument; null when the instrument has one group. */
    number: number | null
    /** Stable id of the group: index of the layer that heads it. */
    groupKey: string
    /** The layer's effective scale. */
    pitch: Pitch
}

type LayerLike = Pick<InstrumentData, 'name' | 'pitch'> & Partial<Pick<InstrumentData, 'extensionLayer'>>

export function layerGroups(instruments: readonly LayerLike[], songPitch: Pitch): LayerGroupInfo[] {
    const counters = new Map<string, number>()
    const numbers: number[] = []
    const heads: number[] = []
    instruments.forEach((layer, index) => {
        const joinsGroup = index > 0 && layer.extensionLayer === true
        const head = joinsGroup ? heads[index - 1] : index
        heads.push(head)
        // an extension of the group's own instrument is numbered as that group
        if (joinsGroup && instruments[head].name === layer.name) {
            numbers.push(numbers[head])
            return
        }
        // a different-instrument extension (WinterPiano under Piano) is numbered on its own,
        // unless an earlier extension of the same group already took a number for it
        const sibling = joinsGroup
            ? instruments.findIndex((other, i) => i < index && heads[i] === head && other.name === layer.name)
            : -1
        if (sibling !== -1) {
            numbers.push(numbers[sibling])
            return
        }
        const next = (counters.get(layer.name) ?? 0) + 1
        counters.set(layer.name, next)
        numbers.push(next)
    })
    return instruments.map((layer, index) => {
        const total = counters.get(layer.name) ?? 1
        return {
            instrumentName: layer.name,
            number: total > 1 ? numbers[index] : null,
            groupKey: String(heads[index]),
            pitch: effectiveTrackPitch(layer, songPitch),
        }
    })
}

/** "Violin 2", "Piano (Eb)": `displayName` turns an instrument id into its shown name. */
export function autoLayerName(
    info: LayerGroupInfo,
    songPitch: Pitch,
    displayName: (instrumentName: string) => string
): string {
    const number = info.number === null ? '' : ` ${info.number}`
    const scale = info.pitch === songPitch ? '' : ` (${info.pitch})`
    return `${displayName(info.instrumentName)}${number}${scale}`
}

/** What a layer is labelled: its typed alias, unless it has none or automatic naming is on. */
export function layerLabels(
    instruments: readonly (LayerLike & Pick<InstrumentData, 'alias' | 'autoName'>)[],
    songPitch: Pitch,
    displayName: (instrumentName: string) => string
): string[] {
    const groups = layerGroups(instruments, songPitch)
    return instruments.map((layer, index) => layer.autoName || !layer.alias
        ? autoLayerName(groups[index], songPitch, displayName)
        : layer.alias)
}

export type LayerScope = 'layer' | 'instrument' | 'group'

/** The layer indices an edit made on layer `index` reaches in the given scope. */
export function layersInScope(
    instruments: readonly LayerLike[],
    index: number,
    scope: LayerScope,
    songPitch: Pitch
): number[] {
    if (scope === 'layer' || instruments[index] === undefined) return [index]
    const groups = layerGroups(instruments, songPitch)
    const target = groups[index]
    return groups
        .map((info, i) => ({info, i}))
        .filter(({info}) => scope === 'instrument'
            ? info.instrumentName === target.instrumentName
            : info.groupKey === target.groupKey)
        .map(({i}) => i)
}
