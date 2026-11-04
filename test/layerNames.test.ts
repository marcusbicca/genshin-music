import {describe, expect, it} from 'vitest'
import {autoLayerName, layerGroups, layerLabels, layersInScope} from '$core/Songs/layerNames'
import {InstrumentData} from '$core/Songs/SongClasses'
import type {Pitch} from '$lib/games/types'

const layer = (name: string, pitch: Pitch | '' = '', extra: Partial<InstrumentData> = {}) =>
    new InstrumentData({name, pitch, ...extra})
const ext = (name: string, pitch: Pitch | '' = '') => layer(name, pitch, {extensionLayer: true})
const shown = (name: string) => name

describe('automatic layer names', () => {
    it('numbers an instrument only when it has more than one group', () => {
        const groups = layerGroups([layer('Piano'), layer('Violin'), layer('Violin')], 'C')
        expect(groups.map(g => g.number)).toEqual([null, 1, 2])
        expect(groups.map(g => autoLayerName(g, 'C', shown))).toEqual(['Piano', 'Violin 1', 'Violin 2'])
    })

    it('shows the scale only when it differs from the song', () => {
        expect(layerLabels([layer('Piano', 'Eb')], 'C', shown)).toEqual(['Piano (Eb)'])
        expect(layerLabels([layer('Piano', 'C')], 'C', shown)).toEqual(['Piano'])
    })

    it('lets an extension layer share the number of the layer it extends', () => {
        const layers = [layer('Violin'), ext('Violin', 'Eb'), layer('Violin')]
        expect(layerLabels(layers, 'C', shown)).toEqual(['Violin 1', 'Violin 1 (Eb)', 'Violin 2'])
    })

    it('numbers a different-instrument extension on its own', () => {
        const layers = [layer('Piano'), ext('WinterPiano'), ext('WinterPiano', 'D'), layer('WinterPiano')]
        expect(layerLabels(layers, 'C', shown)).toEqual(['Piano', 'WinterPiano 1', 'WinterPiano 1 (D)', 'WinterPiano 2'])
    })

    it('labels a layer swapped to an instrument already in the song as the next one', () => {
        const layers = [layer('Piano'), layer('Flute', 'Eb')]
        expect(layerLabels(layers, 'C', shown)).toEqual(['Piano', 'Flute (Eb)'])
        layers[1] = layers[1].withInstrument('Piano')
        expect(layerLabels(layers, 'C', shown)).toEqual(['Piano 1', 'Piano 2 (Eb)'])
    })

    it('keeps a typed alias unless automatic naming is on', () => {
        const layers = [layer('Piano', '', {alias: 'Lead'}), layer('Piano', '', {alias: 'Old', autoName: true})]
        expect(layerLabels(layers, 'C', shown)).toEqual(['Lead', 'Piano 2'])
    })

    it('reaches the right layers for each scope', () => {
        const layers = [layer('Violin'), ext('Violin', 'Eb'), layer('Cello'), layer('Violin')]
        expect(layersInScope(layers, 1, 'layer', 'C')).toEqual([1])
        expect(layersInScope(layers, 1, 'instrument', 'C')).toEqual([0, 1, 3])
        expect(layersInScope(layers, 1, 'group', 'C')).toEqual([0, 1])
        expect(layersInScope(layers, 3, 'group', 'C')).toEqual([3])
    })
})

describe('whole-group instrument swap', () => {
    it('swaps a layer with its extension layers, which stay one group', () => {
        const layers = [layer('Piano'), ext('Piano', 'Eb'), ext('WinterPiano'), layer('Violin')]
        const targets = layersInScope(layers, 0, 'group', 'C')
        expect(targets).toEqual([0, 1, 2])
        const swapped = layers.map((l, i) => (targets.includes(i) ? l.withInstrument('Cello') : l))
        expect(layerLabels(swapped, 'C', shown)).toEqual(['Cello', 'Cello (Eb)', 'Cello', 'Violin'])
        expect(layersInScope(swapped, 2, 'group', 'C')).toEqual([0, 1, 2])
    })
})

describe('layer flags serialization', () => {
    it('writes the flags only when on, so existing songs keep their bytes', () => {
        const plain = layer('Piano').serialize()
        expect('autoName' in plain || 'extensionLayer' in plain).toBe(false)
        const on = layer('Piano', '', {autoName: true, extensionLayer: true}).serialize()
        const back = InstrumentData.deserialize(on)
        expect([back.autoName, back.extensionLayer]).toEqual([true, true])
        expect(InstrumentData.deserialize(plain).autoName).toBe(false)
    })
})
