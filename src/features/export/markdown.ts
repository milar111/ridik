/**
 * Every document the app can hand to another app.
 *
 * Pure by construction — a document is a function of the data plus a zone — so
 * the whole export surface is testable under plain Node and the delivery side
 * (`share.ts`) only has to know how to move bytes.
 *
 * Everything the user ever typed or dictated goes through `escapeMarkdown` on
 * its way in. A note titled "Budget | Q3" or a shopping item called "# 2 pencils"
 * would otherwise silently split a table or promote itself to a heading, and the
 * user would be looking at a broken document with no idea why.
 */
import { countLabel, formatMoney, truncate } from '@/core/format';
import {
  epochToLocal,
  formatDuration,
  formatTime,
  localToEpoch,
  currentZone,
  type LocalDate,
} from '@/core/time';
import type { ActivitySummary } from '@/repositories/activity';
import type { LedgerQueryResult } from '@/repositories/ledger';
import type { ProjectOverview } from '@/repositories/projects';

import type { BriefingData, BriefingTask } from '@/features/briefing/collect';

export type MarkdownOptions = { zone?: string };

export type StandupOptions = MarkdownOptions & {
  title?: string;
  /** Both ends inclusive. Falls back to the span the entries actually cover. */
  range?: { from: LocalDate; to: LocalDate };
};

/**
 * Characters that can change the *structure* of a document rather than just its
 * look. All of them are ASCII punctuation, so a backslash escape renders them
 * back verbatim in CommonMark and GFM alike.
 */
const STRUCTURAL = /[\\`*_[\]|#<>]/g;

/** Collapses newlines too: a stray line break ends a table row or a heading. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(STRUCTURAL, (character) => `\\${character}`);
}

/** Escaped and length-capped, for cells and bullets that must stay one line. */
function cell(text: string, max = 120): string {
  return escapeMarkdown(truncate(text, max));
}

function table(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

/** Noon, because some zones skip midnight itself on the switchover day. */
function dayEpoch(date: LocalDate, zone: string): number {
  return localToEpoch(`${date}T12:00`, zone);
}

function longDay(date: LocalDate, zone: string): string {
  return epochToLocal(dayEpoch(date, zone), zone).toFormat('cccc d LLL');
}

function shortDay(date: LocalDate, zone: string): string {
  return epochToLocal(dayEpoch(date, zone), zone).toFormat('d LLL');
}

function shortDate(epoch: number, zone: string): string {
  return epochToLocal(epoch, zone).toFormat('d LLL yyyy');
}

function stamp(epoch: number, zone: string): string {
  return epochToLocal(epoch, zone).toFormat('ccc d LLL, HH:mm');
}

/** `formatMoney` keeps the sign inside the symbol ("€-190"); a report needs it outside. */
function signedMoney(value: number, currency: string): string {
  const magnitude = formatMoney(Math.abs(value), currency);
  return value < 0 ? `−${magnitude}` : magnitude;
}

/** Blank lines between blocks, with no trailing run at the end of the file. */
function joinBlocks(blocks: (string | string[])[]): string {
  const parts = blocks
    .map((block) => (Array.isArray(block) ? block.join('\n') : block))
    .filter((block) => block.length > 0);
  return `${parts.join('\n\n')}\n`;
}

/* --------------------------------------------------------------- standup -- */

/**
 * `activity.summarise()` grouped into a standup: one section per day, then the
 * totals and the per-project split that turn "what did I do" into "where did
 * the week actually go".
 */
export function weeklyStandup(summary: ActivitySummary, options: StandupOptions = {}): string {
  const zone = options.zone ?? currentZone();
  const heading = `# ${escapeMarkdown(options.title ?? 'Weekly standup')}`;

  if (summary.entries.length === 0) {
    return joinBlocks([heading, '_No activity logged in this period._']);
  }

  const from = options.range?.from ?? summary.byDay[0]!.date;
  const to = options.range?.to ?? summary.byDay[summary.byDay.length - 1]!.date;
  const subtitle = `_${shortDay(from, zone)} – ${shortDay(to, zone)} · ${formatDuration(
    summary.totalMinutes,
  )} across ${countLabel(summary.entries.length, 'entry', 'entries')}_`;

  const days = summary.byDay.map((day) => [
    day.minutes > 0
      ? `## ${longDay(day.date, zone)} — ${formatDuration(day.minutes)}`
      : `## ${longDay(day.date, zone)}`,
    '',
    ...day.entries.map((entry) => {
      const duration = entry.durationMinutes ? ` (${formatDuration(entry.durationMinutes)})` : '';
      return `- ${cell(entry.description)}${duration}`;
    }),
  ]);

  const totals = [
    '## Totals',
    '',
    `- Tracked: ${formatDuration(summary.totalMinutes)}`,
    `- Entries: ${summary.entries.length}`,
    `- Days active: ${summary.byDay.length}`,
  ];

  const blocks: (string | string[])[] = [heading, subtitle, ...days, totals];

  if (summary.byProject.length > 0) {
    blocks.push([
      '## By project',
      '',
      ...table(
        ['Project', 'Entries', 'Time'],
        summary.byProject.map((bucket) => [
          cell(bucket.name ?? 'Unnamed project', 60),
          String(bucket.count),
          formatDuration(bucket.minutes),
        ]),
      ),
    ]);
  }

  if (summary.byHabit.length > 0) {
    blocks.push([
      '## By habit',
      '',
      ...table(
        ['Habit', 'Entries', 'Time'],
        summary.byHabit.map((bucket) => [
          cell(bucket.name ?? 'Unnamed habit', 60),
          String(bucket.count),
          formatDuration(bucket.minutes),
        ]),
      ),
    ]);
  }

  return joinBlocks(blocks);
}

/* -------------------------------------------------------------- briefing -- */

const SCOPE_TITLE: Record<BriefingData['scope'], string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'This week',
};

export function briefingMarkdown(data: BriefingData): string {
  const zone = data.zone;
  const blocks: (string | string[])[] = [
    `# ${SCOPE_TITLE[data.scope]} — ${longDay(data.date, zone)}`,
  ];

  if (data.events.length > 0 || data.classes.length > 0) {
    const rows = [
      ...data.classes.map((entry) => ({
        startsAt: entry.startsAt,
        line: `- ${formatTime(entry.startsAt, zone)}–${formatTime(entry.endsAt, zone)} ${cell(
          entry.subject,
        )}${entry.location ? ` · ${cell(entry.location, 60)}` : ''} _(class)_`,
      })),
      ...data.events.map((event) => {
        const when = event.allDay
          ? 'All day'
          : `${formatTime(event.startsAt, zone)}–${formatTime(event.endsAt, zone)}`;
        const where = event.location ? ` · ${cell(event.location, 60)}` : '';
        const note = event.isBuffer
          ? ` _(travel time${event.bufferFor ? ` for ${cell(event.bufferFor, 40)}` : ''})_`
          : '';
        return { startsAt: event.startsAt, line: `- ${when} ${cell(event.title)}${where}${note}` };
      }),
    ].sort((a, b) => a.startsAt - b.startsAt);

    blocks.push(['## Schedule', '', ...rows.map((row) => row.line)]);
  }

  const taskLine = (task: BriefingTask): string => {
    const due = task.dueDate == null ? '' : ` — due ${stamp(task.dueDate, zone)}`;
    return `- [ ] ${cell(task.title)}${due}`;
  };

  if (data.overdueTasks.length > 0) {
    blocks.push(['## Overdue', '', ...data.overdueTasks.map(taskLine)]);
  }
  if (data.dueTasks.length > 0 || data.upcomingTasks.length > 0) {
    blocks.push([
      '## Due',
      '',
      ...data.dueTasks.map(taskLine),
      ...data.upcomingTasks.map(taskLine),
    ]);
  }
  if (data.unlockedTasks.length > 0) {
    blocks.push(['## Unblocked', '', ...data.unlockedTasks.map(taskLine)]);
  }

  if (data.streaks.length > 0) {
    blocks.push([
      '## Habits',
      '',
      ...data.streaks.map(
        (habit) =>
          `- ${cell(habit.name, 60)} — ${countLabel(habit.streak, 'day')}${
            habit.atRisk ? ' _(at risk today)_' : ''
          }`,
      ),
    ]);
  }

  if (data.commitments.length > 0) {
    blocks.push([
      '## Commitments',
      '',
      ...data.commitments.map((promise) => {
        const who =
          promise.direction === 'i_owe'
            ? `You owe ${cell(promise.personName, 40)}`
            : `${cell(promise.personName, 40)} owes you`;
        const due = promise.dueDate == null ? '' : ` — ${stamp(promise.dueDate, zone)}`;
        const flag = promise.isOverdue ? ' **overdue**' : '';
        return `- ${who}: ${cell(promise.text)}${due}${flag}`;
      }),
    ]);
  }

  if (data.focus) {
    blocks.push([
      '## Focus',
      '',
      `- ${cell(data.focus.label)} — ${data.focus.phase} phase, ${data.focus.status}`,
    ]);
  }

  if (data.unsyncedCount > 0) {
    blocks.push(`_${countLabel(data.unsyncedCount, 'change')} still waiting to sync._`);
  }

  if (blocks.length === 1) blocks.push('_Nothing scheduled and nothing due._');
  return joinBlocks(blocks);
}

/* --------------------------------------------------------------- project -- */

export function projectMarkdown(overview: ProjectOverview, options: MarkdownOptions = {}): string {
  const zone = options.zone ?? currentZone();
  const { project, counts, linked } = overview;
  const emoji = project.emoji ? `${project.emoji} ` : '';

  const meta = [`${project.kind}`, `${project.status}`];
  if (project.targetDate != null) meta.push(`target ${shortDate(project.targetDate, zone)}`);
  meta.push(`${counts.done}/${counts.total} done`);
  if (counts.openTodos > 0) meta.push(`${countLabel(counts.openTodos, 'open todo')}`);

  const blocks: (string | string[])[] = [
    `# ${emoji}${escapeMarkdown(project.name)}`,
    `_${meta.map((part) => escapeMarkdown(part)).join(' · ')}_`,
  ];
  if (project.description) blocks.push(escapeMarkdown(project.description));

  for (const view of overview.sections) {
    if (view.items.length === 0) continue;
    const heading = view.section ? `## ${escapeMarkdown(view.section.title)}` : '## Items';
    blocks.push([
      heading,
      '',
      ...view.items.map((item) => {
        const box = item.isCheckbox ? (item.isCompleted ? '[x] ' : '[ ] ') : '';
        const detail = item.detail ? ` — ${cell(item.detail)}` : '';
        const due = item.dueDate == null ? '' : ` (due ${shortDate(item.dueDate, zone)})`;
        return `- ${box}${cell(item.content)}${detail}${due}`;
      }),
    ]);
  }

  if (linked.tasks.length > 0) {
    blocks.push([
      '## Linked tasks',
      '',
      ...linked.tasks.map((task) => {
        const box = task.isCompleted ? '[x] ' : '[ ] ';
        const due = task.dueDate == null ? '' : ` — due ${shortDate(task.dueDate, zone)}`;
        const blocked = task.isLocked ? ' _(blocked)_' : '';
        return `- ${box}${cell(task.title)}${due}${blocked}`;
      }),
    ]);
  }

  if (linked.notes.length > 0) {
    blocks.push([
      '## Notes',
      '',
      ...linked.notes.map(
        (note) => `- ${cell(note.titleSummary)} _(${escapeMarkdown(note.categoryTag)})_`,
      ),
    ]);
  }

  if (linked.checklists.length > 0) {
    blocks.push([
      '## Checklist items',
      '',
      ...linked.checklists.map((item) => {
        const box = item.isCompleted ? '[x] ' : '[ ] ';
        const quantity = item.quantity ? ` ×${escapeMarkdown(item.quantity)}` : '';
        return `- ${box}${cell(item.itemText)}${quantity} _(${escapeMarkdown(item.listName)})_`;
      }),
    ]);
  }

  if (linked.transactions.length > 0) {
    blocks.push([
      '## Spending',
      '',
      ...table(
        ['Date', 'Category', 'Amount'],
        linked.transactions.map((row) => [
          escapeMarkdown(shortDate(row.createdAt, zone)),
          cell(row.category, 40),
          escapeMarkdown(
            row.direction === 'income'
              ? `+${formatMoney(row.amount, row.currency)}`
              : signedMoney(-row.amount, row.currency),
          ),
        ]),
      ),
    ]);
  }

  if (blocks.length === 2 && !project.description) blocks.push('_This project is still empty._');
  return joinBlocks(blocks);
}

/* ---------------------------------------------------------------- ledger -- */

export function ledgerMarkdown(result: LedgerQueryResult, options: MarkdownOptions = {}): string {
  const zone = options.zone ?? currentZone();

  // The end bound is exclusive; a report that says "to 1 September" for an
  // August query is wrong in the only way a financial report must never be.
  const span =
    result.from == null && result.to == null
      ? 'All time'
      : `${result.from == null ? 'Start' : shortDate(result.from, zone)} – ${
          result.to == null ? 'now' : shortDate(result.to - 1, zone)
        }`;

  const blocks: (string | string[])[] = [
    '# Ledger',
    `_${escapeMarkdown(span)} · ${countLabel(result.count, 'transaction')}_`,
  ];

  const currencies = [
    ...new Set([
      ...Object.keys(result.expenseByCurrency),
      ...Object.keys(result.incomeByCurrency),
      ...Object.keys(result.netByCurrency),
    ]),
  ].sort();

  if (currencies.length === 0) {
    blocks.push('_Nothing recorded in this period._');
    return joinBlocks(blocks);
  }

  blocks.push([
    '## Totals',
    '',
    // Never one number across currencies: a summed EUR+USD total is a lie that
    // reads like a fact.
    ...table(
      ['Currency', 'Spent', 'Received', 'Net'],
      currencies.map((currency) => [
        escapeMarkdown(currency),
        escapeMarkdown(formatMoney(result.expenseByCurrency[currency] ?? 0, currency)),
        escapeMarkdown(formatMoney(result.incomeByCurrency[currency] ?? 0, currency)),
        escapeMarkdown(signedMoney(result.netByCurrency[currency] ?? 0, currency)),
      ]),
    ),
  ]);

  if (result.groups.length > 0) {
    const fallback = result.primaryCurrency ?? currencies[0]!;
    blocks.push([
      '## Breakdown',
      '',
      ...table(
        ['Group', 'Count', 'Total'],
        result.groups.map((group) => {
          const codes = Object.keys(group.totalsByCurrency).sort();
          const amounts =
            codes.length === 0
              ? formatMoney(0, fallback)
              : codes
                  .map((code) => formatMoney(group.totalsByCurrency[code] ?? 0, code))
                  .join(' + ');
          return [cell(group.key, 40), String(group.count), escapeMarkdown(amounts)];
        }),
      ),
    ]);
  }

  return joinBlocks(blocks);
}

/* ------------------------------------------------------------------ html -- */

export type HtmlOptions = { title?: string };

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

const STYLE = `
:root { color-scheme: light; }
body { font: 14px/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #16181d; margin: 40px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 26px 0 6px; border-bottom: 1px solid #e3e5ea; padding-bottom: 4px; }
h3 { font-size: 15px; margin: 18px 0 4px; }
p { margin: 6px 0; }
em { color: #6b7280; font-style: normal; }
ul { margin: 6px 0; padding-left: 20px; }
li { margin: 2px 0; }
table { border-collapse: collapse; margin: 10px 0; width: 100%; }
th, td { border: 1px solid #e3e5ea; padding: 6px 9px; text-align: left; }
th { background: #f5f6f8; font-weight: 600; }
code { background: #f5f6f8; padding: 1px 4px; border-radius: 3px; }
hr { border: 0; border-top: 1px solid #e3e5ea; margin: 20px 0; }
`.trim();

/**
 * A deliberately small markdown subset — headings, bullets, tables, emphasis —
 * because that is exactly what the generators above emit and a full parser
 * would be a second source of truth.
 *
 * The escapes the generators added are pulled out *before* anything is
 * interpreted, so a task literally called "\*\*urgent\*\*" comes back as the
 * six characters the user typed rather than as bold text.
 */
export function markdownToHtml(markdown: string, options: HtmlOptions = {}): string {
  const title = options.title ?? 'Ridik export';
  const out: string[] = [];
  let list: string[] | null = null;
  let rows: string[][] | null = null;

  const closeList = (): void => {
    if (!list) return;
    out.push(`<ul>${list.join('')}</ul>`);
    list = null;
  };
  const closeTable = (): void => {
    if (!rows) return;
    const [header, ...body] = rows;
    const head = header ? `<thead><tr>${header.map((c) => `<th>${c}</th>`).join('')}</tr></thead>` : '';
    const cells = body
      .map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('');
    out.push(`<table>${head}<tbody>${cells}</tbody></table>`);
    rows = null;
  };
  const closeBlocks = (): void => {
    closeList();
    closeTable();
  };

  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();

    if (line.trim().length === 0) {
      closeBlocks();
      continue;
    }

    const tableRow = line.match(/^\|(.*)\|$/);
    if (tableRow) {
      closeList();
      const cells = splitRow(tableRow[1] ?? '');
      // The `| --- |` divider carries no content; it only marks the header.
      if (cells.every((value) => /^:?-{2,}:?$/.test(value.trim()))) continue;
      rows = rows ?? [];
      rows.push(cells.map((value) => inlineHtml(value.trim())));
      continue;
    }
    closeTable();

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inlineHtml(heading[2] ?? '')}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      const content = (bullet[1] ?? '').replace(/^\[( |x|X)\]\s*/, (_, mark: string) =>
        mark === ' ' ? '☐ ' : '☑ ',
      );
      list = list ?? [];
      list.push(`<li>${inlineHtml(content)}</li>`);
      continue;
    }
    closeList();

    if (/^-{3,}$/.test(line.trim())) {
      out.push('<hr />');
      continue;
    }

    const emphasised = line.match(/^_(.+)_$/);
    if (emphasised) {
      out.push(`<p><em>${inlineHtml(emphasised[1] ?? '')}</em></p>`);
      continue;
    }

    out.push(`<p>${inlineHtml(line)}</p>`);
  }
  closeBlocks();

  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8" />',
    `<meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
    out.join('\n'),
    '</body></html>',
  ].join('\n');
}

/** Splits on unescaped pipes only, so an escaped `\|` stays inside its cell. */
function splitRow(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < row.length; i++) {
    const character = row[i]!;
    if (character === '\\' && i + 1 < row.length) {
      current += character + row[i + 1]!;
      i++;
      continue;
    }
    if (character === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current);
  return cells;
}

/** Not producible by any generator above, so the mask can never collide. */
const SENTINEL = '\u0000';

function inlineHtml(text: string): string {
  // Stash backslash escapes first. Doing it afterwards would let the user's own
  // literal asterisks be read as emphasis before we ever got to them.
  const stashed: string[] = [];
  const masked = text.replace(/\\(.)/g, (_, character: string) => {
    stashed.push(escapeHtml(character));
    return `${SENTINEL}${stashed.length - 1}${SENTINEL}`;
  });

  const html = escapeHtml(masked)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|\s)_([^_]+)_(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>');

  return html.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g'),
    (_, index: string) => stashed[Number(index)] ?? '',
  );
}
