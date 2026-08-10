/**
 * The vocabulary of the projects feature.
 *
 * Kinds and item kinds come from the schema enums, so the lists here are
 * exhaustive `Record`s rather than arrays of guesses: adding a kind to the
 * schema breaks this file at compile time instead of silently rendering a row
 * with no icon.
 */
import type { Ionicons } from '@expo/vector-icons';

import type { ProjectItemKind, ProjectKind, ProjectStatus } from '@/repositories/projects';

export type IconName = keyof typeof Ionicons.glyphMap;

export const PROJECT_KIND_LABEL: Record<ProjectKind, string> = {
  project: 'Project',
  event: 'Event',
  trip: 'Trip',
  area: 'Area',
  course: 'Course',
};

export const PROJECT_KIND_ICON: Record<ProjectKind, IconName> = {
  project: 'albums-outline',
  event: 'sparkles-outline',
  trip: 'airplane-outline',
  area: 'layers-outline',
  course: 'school-outline',
};

export const PROJECT_KINDS: readonly ProjectKind[] = [
  'project',
  'event',
  'trip',
  'area',
  'course',
];

export const ITEM_KIND_LABEL: Record<ProjectItemKind, string> = {
  todo: 'To-do',
  idea: 'Idea',
  note: 'Note',
  question: 'Question',
  milestone: 'Milestone',
  link: 'Link',
};

export const ITEM_KIND_ICON: Record<ProjectItemKind, IconName> = {
  todo: 'checkbox-outline',
  idea: 'bulb-outline',
  note: 'document-text-outline',
  question: 'help-circle-outline',
  milestone: 'flag-outline',
  link: 'link-outline',
};

/** Ordered for the add bar: the thing people dictate most sits first. */
export const ITEM_KINDS: readonly ProjectItemKind[] = [
  'todo',
  'idea',
  'note',
  'question',
  'milestone',
  'link',
];

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
  archived: 'Archived',
};

/** The order the list screen stacks its groups in. */
export const STATUS_ORDER: readonly ProjectStatus[] = ['active', 'paused', 'done', 'archived'];

/**
 * A small curated set. A full emoji keyboard is a worse picker than the system
 * one, and the point here is a single tap that makes the row scannable.
 */
export const EMOJI_CHOICES: readonly string[] = [
  '🗂',
  '✈️',
  '🏖',
  '🎓',
  '🏠',
  '🛠',
  '🎉',
  '💼',
  '🚗',
  '🍽',
  '🏃',
  '📚',
  '🎬',
  '💡',
  '🧳',
  '🎁',
];

export const UNSECTIONED_TITLE = 'Items';
