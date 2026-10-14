import { describe, expect, it } from 'vitest';
import { actionLabel } from '../../src/policy/label.js';

describe('action labels', () => {
  it('shows paths inside the project relative to it, and others in full', () => {
    expect(actionLabel({ kind: 'write', path: '/work/app/src/a.ts' }, '/work/app')).toBe(
      'write src/a.ts',
    );
    expect(actionLabel({ kind: 'write', path: '/etc/hosts' }, '/work/app')).toBe(
      'write /etc/hosts',
    );
    expect(actionLabel({ kind: 'read', path: '/work/app', glob: '*.env' }, '/work/app')).toBe(
      'read /work/app (*.env)',
    );
    expect(
      actionLabel(
        { kind: 'patch', files: [{ path: '/work/app/a.ts', op: 'update', to: '/work/app/b.ts' }] },
        '/work/app',
      ),
    ).toBe('apply_patch: update a.ts -> b.ts');
  });

  it('leaves paths alone without a project', () => {
    expect(actionLabel({ kind: 'write', path: '/work/app/src/a.ts' })).toBe(
      'write /work/app/src/a.ts',
    );
  });
});
