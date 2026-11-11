import { describe, expect, it } from 'vitest';
import { ComposedSong, INSTRUMENTS, INSTRUMENTS_DATA } from './imports';
import { composedMergeOptions, layerKeys, planComposedMerge } from '$core/Songs/composedLayerMerge';
import { planLayerMerge } from '$core/Songs/layerMerge';

const name = INSTRUMENTS[0];
const sounding = INSTRUMENTS_DATA[name].notes.map((note) => note.sounding);
const top = Math.max(...sounding);
const low = Math.min(...sounding);

describe('merging a layer with its notes fitted onto the destination', () => {
  it('moves a note past the range by octaves, keeps playable ones, drops none', () => {
    const song = new ComposedSong('fit', [name, name]);
    song.addNoteAt(0, 1, low, 2); // playable as is
    song.addNoteAt(1, 1, low + 36, 1); // the same note three octaves up: past the range
    const option = planComposedMerge(song.columns, song.instruments, song.pitch, 1, 0);
    expect(option.plan.stats.kept).toBe(1);
    expect(option.plan.stats.octave).toBe(1);

    song.mergeTrackInto(1, 0, option.remap);

    expect(song.instruments).toHaveLength(1);
    expect(song.columns[0].notesOfTrack(0).map((n) => [n.id, n.span])).toEqual([[low, 2]]);
    const moved = song.columns[1].notesOfTrack(0)[0].id;
    expect((moved - low) % 12).toBe(0);
    expect(layerKeys(song.instruments[0], song.pitch)).toContain(moved);
    expect(song.countStrandedNotes()).toBe(0);
  });

  it('is one undo step, notes and roster together', () => {
    const song = new ComposedSong('fit undo', [name, name]);
    song.attachHistory();
    song.addNoteAt(0, 1, low + 36, 1);
    const before = JSON.stringify(song.serialize().tracks);
    const option = planComposedMerge(song.columns, song.instruments, song.pitch, 1, 0);
    song.mergeTrackInto(1, 0, option.remap);
    song.undo();
    expect(JSON.stringify(song.serialize().tracks)).toBe(before);
  });

  it("keeps or deletes notes with no key there, as the policy says", () => {
    const missing = top + 100; // no instrument plays it, in any octave of its range
    const keys = layerKeys(new ComposedSong('k', [name]).instruments[0], 'C');
    const offScale = Array.from({ length: 12 }, (_, i) => low + i).find(
      (value) => !keys.some((key) => (key - value) % 12 === 0)
    );
    const value = offScale ?? missing;
    for (const [policy, expected] of [
      ['keep', 1],
      ['drop', 0],
    ] as const) {
      const song = new ComposedSong('policy', [name, name]);
      song.addNoteAt(0, 1, value, 1);
      const option = planComposedMerge(song.columns, song.instruments, song.pitch, 1, 0, false, policy);
      song.mergeTrackInto(1, 0, option.remap);
      expect(song.columns[0].notesOfTrack(0)).toHaveLength(expected);
      if (policy === 'keep' && offScale !== undefined) expect(song.countStrandedNotes(0)).toBe(1);
    }
  });

  it('deletes the notes a layer cannot sound, and nothing else', () => {
    const song = new ComposedSong('stranded', [name, name]);
    song.attachHistory();
    song.addNoteAt(0, 0, low, 1);
    song.addNoteAt(1, 0, top + 13, 1);
    song.addNoteAt(1, 1, top + 13, 1);
    song.removeStrandedNotes(0);
    expect(song.columns[0].notesOfTrack(0)).toHaveLength(1);
    expect(song.columns[1].notesOfTrack(0)).toHaveLength(0);
    expect(song.columns[1].notesOfTrack(1)).toHaveLength(1);
    song.undo();
    expect(song.columns[1].notesOfTrack(0)).toHaveLength(1);
  });

  it("suggests the source's own group first", () => {
    const song = new ComposedSong('groups', [name, name, name]);
    song.instruments = song.instruments.map((layer, i) =>
      i === 1 ? layer.clone().set({ extensionLayer: true }) : layer
    );
    song.addNoteAt(0, 1, low, 1);
    const { options, suggested } = composedMergeOptions(song.columns, song.instruments, song.pitch, 1);
    expect(options.map((option) => option.into)).toEqual([0, 2]);
    expect(options[0].inGroup).toBe(true);
    expect(suggested?.into).toBe(0);
  });
});

describe('planLayerMerge policies', () => {
  const keys = [60, 62, 64];
  it('nearest moves, keep leaves, drop removes a note whose pitch class is missing', () => {
    const notes = [{ slot: 0, value: 61 }];
    expect(planLayerMerge(notes, keys, () => false, 'nearest').values).toEqual([60]);
    expect(planLayerMerge(notes, keys, () => false, 'keep').values).toEqual([61]);
    expect(planLayerMerge(notes, keys, () => false, 'drop').values).toEqual([null]);
  });
});
