import type { PatchFile } from '../../policy/types.js';

/**
 * Reads the files an apply_patch envelope touches:
 *
 *   *** Begin Patch
 *   *** Update File: src/app.ts
 *   *** Move to: src/main.ts
 *   *** Add File: src/new.ts
 *   *** Delete File: src/old.ts
 *   *** End Patch
 *
 * The envelope may arrive bare or wrapped in a shell heredoc, so markers are found
 * anywhere in the text.
 */
export function parseApplyPatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let last: PatchFile | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      last = { path: m[2]!.trim(), op: m[1]!.toLowerCase() as PatchFile['op'] };
      files.push(last);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && last) last.to = move[1]!.trim();
  }
  return files;
}
