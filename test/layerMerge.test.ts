import { describe, expect, it } from 'vitest';
import { fitToKeys, planLayerMerge, suggestMergeTarget } from '$core/Songs/layerMerge';

// a C major scale over two octaves, C4..B5
const cMajor = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83];

describe('fitToKeys', () => {
  it('keeps a playable note', () => {
    expect(fitToKeys(64, cMajor)).toEqual({ value: 64, move: 'kept' });
  });
  it('moves an out-of-range note by octaves to the nearest copy of its pitch class', () => {
    expect(fitToKeys(88, cMajor)).toEqual({ value: 76, move: 'octave' }); // E7 -> E5
    expect(fitToKeys(43, cMajor)).toEqual({ value: 67, move: 'octave' }); // G2 -> G4
  });
  it('changes note only when the pitch class is missing, to the nearest key, lower on a tie', () => {
    expect(fitToKeys(66, cMajor)).toEqual({ value: 65, move: 'pitch' }); // F# -> F (tie F/G)
    expect(fitToKeys(90, cMajor)).toEqual({ value: 83, move: 'pitch' }); // F#6 -> B5
  });
  it('has nothing to offer for an empty key set', () => {
    expect(fitToKeys(60, [])).toBeNull();
  });
});

describe('planLayerMerge', () => {
  it('counts what happens to each note and the collisions with the destination', () => {
    const notes = [
      { slot: 0, value: 64 }, // kept
      { slot: 0, value: 76 + 12 }, // octave -> 76
      { slot: 1, value: 66 }, // pitch -> 65
      { slot: 2, value: 72 + 12 }, // octave: 72 is taken at that moment, so the free 60
    ];
    const plan = planLayerMerge(notes, cMajor, (slot, value) => slot === 2 && value === 72);
    expect(plan.values).toEqual([64, 76, 65, 60]);
    expect(plan.stats).toEqual({ kept: 1, octave: 2, pitch: 1, merged: 0 });
  });
  it('merges onto a taken key only when every octave of the note is taken', () => {
    const plan = planLayerMerge([{ slot: 0, value: 84 }], cMajor, (_, value) => value % 12 === 0);
    expect(plan.values).toEqual([72]);
    expect(plan.stats.merged).toBe(1);
  });
  it('counts two source notes landing on the same key as a merge', () => {
    const plan = planLayerMerge(
      [
        { slot: 0, value: 64 },
        { slot: 0, value: 76 + 12 + 12 },
      ],
      [64],
      () => false
    );
    expect(plan.stats.merged).toBe(1);
  });
});

describe('suggestMergeTarget', () => {
  it('prefers octave moves over changes of note, and the first candidate on a tie', () => {
    const notes = [
      { slot: 0, value: 66 },
      { slot: 1, value: 78 },
    ]; // F#4, F#5
    const withFSharp = { name: 'G major', plan: planLayerMerge(notes, [66, 67, 69], () => false) };
    const without = { name: 'C major', plan: planLayerMerge(notes, cMajor, () => false) };
    expect(suggestMergeTarget([without, withFSharp])?.name).toBe('G major');
    const twin = { name: 'twin', plan: withFSharp.plan };
    expect(suggestMergeTarget([withFSharp, twin])?.name).toBe('G major');
    expect(suggestMergeTarget([])).toBeUndefined();
  });
});

describe('keeping a note with no key', () => {
  it('moves it by octaves into the destination range, never changing the note', () => {
    const plan = planLayerMerge([{ slot: 0, value: 66 + 24 }], [60, 62, 64, 65, 67, 69, 71, 72], () => false, 'keep');
    expect(plan.values).toEqual([66]);
    expect(plan.stats.pitch).toBe(1);
  });
});
