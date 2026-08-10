import { escapeMarkdown } from '@/features/export';
import type { NoteWithBullets } from '@/repositories/notes';

/**
 * A note as a shareable document.
 *
 * Everything the user dictated goes through `escapeMarkdown` first, for the
 * same reason the rest of the export surface does it: a bullet that happens to
 * start with "# " or contain a pipe would otherwise silently restructure the
 * document the recipient opens.
 */
export function noteMarkdown(note: NoteWithBullets): string {
  const lines = [
    `# ${escapeMarkdown(note.titleSummary)}`,
    '',
    `_${escapeMarkdown(note.categoryTag)}_`,
    '',
  ];

  if (note.bullets.length === 0) {
    lines.push('_This note is empty._');
  } else {
    for (const bullet of note.bullets) {
      const box = bullet.bulletKind === 'todo' ? (bullet.isCompleted ? '[x] ' : '[ ] ') : '';
      lines.push(`- ${box}${escapeMarkdown(bullet.content)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Filename stem for the share sheet; `shareAsFile` sanitises the rest. */
export function noteFilename(note: NoteWithBullets): string {
  return `${note.titleSummary}.md`;
}
