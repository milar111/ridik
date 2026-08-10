/**
 * The projects feature surface. The two routes import from here only, so the
 * screens stay about flow and this folder stays about presentation.
 */
export { DueChip, ErrorRow, ProgressBar, SkeletonRows } from './Bits';
export { AddItemBar } from './AddItemBar';
export type { AddItemDraft } from './AddItemBar';
export { CreateProjectSheet } from './CreateProjectSheet';
export { LinkedPanel } from './LinkedPanel';
export { MenuSheet } from './Menu';
export type { MenuOption } from './Menu';
export { ProjectCard } from './ProjectCard';
export { ProjectHeader } from './ProjectHeader';
export { ProjectItemRow } from './ProjectItemRow';
export { SectionGroup } from './SectionGroup';

export {
  EMOJI_CHOICES,
  ITEM_KINDS,
  ITEM_KIND_ICON,
  ITEM_KIND_LABEL,
  PROJECT_KINDS,
  PROJECT_KIND_ICON,
  PROJECT_KIND_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
  UNSECTIONED_TITLE,
} from './constants';
export type { IconName } from './constants';

export { currencyTotals, deadlineOf, errorMessage } from './format';
export type { CurrencyTotal, Deadline, DeadlineTone } from './format';
