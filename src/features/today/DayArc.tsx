import { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { formatTime } from '@/core/time';
import { Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

import { arcPath, arcPathTo, arcPointAt, dayFraction, type ArcGeometry } from './arc';
import type { Agenda, AgendaItem } from './agenda';

/**
 * The day drawn as an arc, with `now` on it and the next thing ahead of it.
 *
 * From the `horizon` direction. The list below already says *what* is on today;
 * this says *where in the day you are*, which is the one question a list of
 * times makes you answer by arithmetic. The elapsed stroke is the answer.
 *
 * All the geometry lives in `arc.ts` and is tested there. What is left here
 * is the two things a test cannot check: that the marks land on the curve, and
 * that the whole thing says something out loud to a screen reader, because an
 * arc with two dots on it is otherwise the purest example of the failure
 * `src/ui/a11y.ts` was written about — information carried only by position.
 */

/** Tall enough for the curve to read as a curve, short enough to precede a list. */
const HEIGHT = 96;

/**
 * Room for the stroke and for a marker sitting on it.
 *
 * The peak marker is the constraint: at midday the dot straddles the top of the
 * curve, so half of it plus the stroke has to fit above the highest point.
 */
const INSET = 14;

const MARKER = 9;

/**
 * Tracked mono, sized to its own content, is the exact case Android measures
 * short — `letterSpacing` is not counted, so the last character is clipped.
 * A fixed width and `textAlign` is the documented fix, and it doubles as the
 * box the label is centred on.
 */
const LABEL_WIDTH = 56;

export type DayArcProps = {
  agenda: Agenda;
  /** The local day the snapshot is showing, half-open, in epoch ms. */
  window: { start: number; end: number };
  now: number;
  zone?: string;
  testID?: string;
};

export function DayArc({ agenda, window, now, zone, testID }: DayArcProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);

  const next = useMemo(() => nextUpcoming(agenda, now), [agenda, now]);

  const geometry: ArcGeometry = { width, height: HEIGHT, inset: INSET };
  const elapsed = dayFraction(now, window);
  const nowAt = arcPointAt(elapsed, geometry);
  const nextFraction = next ? dayFraction(next.startsAt, window) : null;
  const nextAt = nextFraction === null ? null : arcPointAt(nextFraction, geometry);

  const onLayout = (event: LayoutChangeEvent): void => {
    const measured = event.nativeEvent.layout.width;
    // Rounded before it reaches state: a fractional width from a rotation or a
    // font-scale change would otherwise re-render the whole arc every frame.
    const rounded = Math.round(measured);
    if (rounded !== width) setWidth(rounded);
  };

  return (
    <View
      style={styles.wrap}
      onLayout={onLayout}
      testID={testID}
      // One sentence for the whole graphic. The marks are decorative to a
      // screen reader — their meaning is this label — so nothing inside is
      // focusable and the arc is never walked dot by dot.
      accessible
      accessibilityRole="image"
      accessibilityLabel={describe(elapsed, next, zone)}
    >
      {width > 0 ? (
        <>
          <Svg width={width} height={HEIGHT} pointerEvents="none">
            {/* The whole day, faint: the part still ahead of you. */}
            <Path
              d={arcPath(geometry)}
              fill="none"
              stroke={colors.border}
              strokeWidth={2}
              strokeLinecap="round"
            />
            {/*
              The part behind you, in the text-safe ember rather than `heat.core`
              — this is a 2.5pt line, and `heat` is only ever a large fill.
            */}
            <Path
              d={arcPathTo(elapsed, geometry)}
              fill="none"
              stroke={colors.accent}
              strokeWidth={2.5}
              strokeLinecap="round"
            />
          </Svg>

          {nextAt && nextFraction !== null ? (
            <>
              <View
                style={[
                  styles.marker,
                  styles.markerHollow,
                  {
                    borderColor: colors.accent,
                    backgroundColor: colors.surface,
                    left: nextAt.x - MARKER / 2,
                    top: nextAt.y - MARKER / 2,
                  },
                ]}
              />
              <Label x={nextAt.x} y={nextAt.y + MARKER} width={width}>
                {formatTime(next!.startsAt, zone)}
              </Label>
            </>
          ) : null}

          {/* Drawn after the next mark so the two never hide `now`. */}
          <View
            style={[
              styles.marker,
              {
                backgroundColor: colors.accent,
                left: nowAt.x - MARKER / 2,
                top: nowAt.y - MARKER / 2,
              },
            ]}
          />
          <Label x={nowAt.x} y={nowAt.y - MARKER - 14} width={width} accent>
            now
          </Label>
        </>
      ) : null}
    </View>
  );
}

/**
 * A mono label centred on a point, kept inside the box.
 *
 * Clamped because both marks reach the ends of the curve: `now` at 23:59 and a
 * next thing early in the morning both put the label half outside the view,
 * where it is clipped rather than wrapped.
 */
function Label({
  x,
  y,
  width,
  accent,
  children,
}: {
  x: number;
  y: number;
  width: number;
  accent?: boolean;
  children: string;
}) {
  const left = Math.max(0, Math.min(width - LABEL_WIDTH, x - LABEL_WIDTH / 2));
  return (
    <Txt
      variant="eyebrow"
      tone={accent ? 'accent' : 'tertiary'}
      style={[styles.label, { left, top: y }]}
      numberOfLines={1}
    >
      {children}
    </Txt>
  );
}

/** The first thing that has not started yet. */
function nextUpcoming(agenda: Agenda, now: number): AgendaItem | null {
  for (const item of agenda.timed) {
    if (item.startsAt > now) return item;
  }
  return null;
}

/**
 * What the arc says, in words.
 *
 * Deliberately not "43 percent through the day": a proportion is what the shape
 * encodes, not what it means. The useful reading is the same one the marks give
 * a sighted user — roughly where in the day you are, and what is next.
 */
function describe(elapsed: number, next: AgendaItem | null, zone?: string): string {
  const part =
    elapsed <= 0.01
      ? 'The day has not started'
      : elapsed >= 0.99
        ? 'The day is over'
        : `${Math.round(elapsed * 100)}% through the day`;
  if (!next) return `${part}. Nothing left today.`;
  return `${part}. Next: ${next.title} at ${formatTime(next.startsAt, zone)}.`;
}

const styles = StyleSheet.create({
  // No bottom margin: `Section` already puts its own gap between this and the
  // list, and the curve's feet sit an `INSET` above the box's own bottom edge.
  wrap: { height: HEIGHT, position: 'relative' },
  marker: {
    position: 'absolute',
    width: MARKER,
    height: MARKER,
    borderRadius: MARKER / 2,
  },
  markerHollow: { borderWidth: 2 },
  label: {
    position: 'absolute',
    width: LABEL_WIDTH,
    textAlign: 'center',
  },
});
