import { describe, expect, it } from 'vitest';
import { withoutOtherAgents, type StepChanges } from '../../src/snapshots/undo.js';

const step = (
  session: string,
  start: number,
  end: number,
  changed: string[],
  writes: string[] = [],
): StepChanges => ({
  step: 1,
  session,
  start,
  end,
  label: '',
  tool: 'Bash',
  pre: { tree: 'p' },
  post: { tree: 'q', ...(writes.length ? { writes } : {}) },
  changes: changed.map((path) => ({ path, status: 'M' as const })),
});

describe('withoutOtherAgents', () => {
  it('keeps everything when no other agent ran at the same time', () => {
    const mine = step('a', 10, 20, ['x', 'y']);
    const later = step('b', 30, 40, ['x']);
    expect(withoutOtherAgents([mine], [later])[0]!.changes.map((c) => c.path)).toEqual(['x', 'y']);
  });

  it("drops a file the other agent's command says it wrote", () => {
    const mine = step('a', 10, 20, ['mine', 'theirs'], ['mine']);
    const theirs = step('b', 12, 18, ['mine', 'theirs'], ['theirs']);
    const [s] = withoutOtherAgents([mine], [theirs]);
    expect(s!.changes.map((c) => c.path)).toEqual(['mine']);
    expect(s!.shared).toBeUndefined();
  });

  it('marks a file shared when both or neither say they wrote it', () => {
    const mine = step('a', 10, 20, ['both', 'neither'], ['both']);
    const theirs = step('b', 15, 25, ['both', 'neither'], ['both']);
    const [s] = withoutOtherAgents([mine], [theirs]);
    expect(s!.shared?.map((x) => x.path).sort()).toEqual(['both', 'neither']);
  });

  it('ignores steps of the same session and drops steps left with no changes', () => {
    const mine = step('a', 10, 20, ['theirs']);
    const same = step('a', 12, 18, ['theirs'], ['theirs']);
    const theirs = step('b', 12, 18, ['theirs'], ['theirs']);
    expect(withoutOtherAgents([mine], [same])).toHaveLength(1);
    expect(withoutOtherAgents([mine], [theirs])).toEqual([]);
  });
});
