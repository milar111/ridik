/**
 * Where the tour's spotlight goes, measured by the things it points at.
 *
 * The alternative was a table of coordinates, which is wrong for the same
 * reason a screenshot in a manual is wrong: home is laid out against the safe
 * area, the day may or may not have loaded, and a ring drawn at a remembered
 * position lands on empty ground the first time anything moves. So each control
 * reports its own frame and the overlay reads it.
 *
 * Frames are in **window** coordinates, from `measureInWindow`, because the
 * overlay is absolutely positioned over the whole screen and knows nothing
 * about the tree the target sits in.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { LayoutChangeEvent, View } from 'react-native';

import type { TourTargetId } from './steps';

export type TourFrame = { x: number; y: number; width: number; height: number };

type TourContextValue = {
  frames: Partial<Record<TourTargetId, TourFrame>>;
  report: (id: TourTargetId, frame: TourFrame | null) => void;
};

const TourContext = createContext<TourContextValue | null>(null);

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [frames, setFrames] = useState<Partial<Record<TourTargetId, TourFrame>>>({});

  /*
   * Reports are collected and applied together.
   *
   * Thirteen menu rows measuring themselves used to be thirteen context values
   * and thirteen renders of everything under the provider, all inside the frame
   * the sheet was trying to animate — which is most of what "really laggy" was.
   * They all land in the same tick, so one animation frame collapses them into
   * a single update.
   *
   * The obvious alternative — let only the row the walk is heading for report —
   * was tried and is a trap: it depends on the walk being set before the menu
   * lays out, which is not guaranteed, and when it lost that race the row never
   * reported at all. The tour then had nothing to ring and nothing to pace on,
   * so it sat on an undressed menu until its backstop fired.
   */
  const pending = useRef<Partial<Record<TourTargetId, TourFrame | null>>>({});
  const flush = useRef<number | null>(null);

  const report = useCallback((id: TourTargetId, frame: TourFrame | null) => {
    pending.current[id] = frame;
    if (flush.current !== null) return;
    flush.current = requestAnimationFrame(() => {
      flush.current = null;
      const batch = pending.current;
      pending.current = {};
      setFrames((current) => {
        let next = current;
        for (const key of Object.keys(batch) as TourTargetId[]) {
          next = merge(next, key, batch[key] ?? null);
        }
        return next;
      });
    });
  }, []);

  const value = useMemo(() => ({ frames, report }), [frames, report]);
  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

/**
 * One frame into the table, returning the table itself when nothing moved.
 *
 * Layout fires far more often than anything moves — every keyboard, every
 * re-render of a parent — and a new object each time would redraw every
 * overlay reading this on all of them.
 */
function merge(
  current: Partial<Record<TourTargetId, TourFrame>>,
  id: TourTargetId,
  frame: TourFrame | null,
): Partial<Record<TourTargetId, TourFrame>> {
  const previous = current[id];
  if (frame === null) {
    if (!previous) return current;
    const { [id]: _dropped, ...rest } = current;
    return rest;
  }
  if (
    previous &&
    previous.x === frame.x &&
    previous.y === frame.y &&
    previous.width === frame.width &&
    previous.height === frame.height
  ) {
    return current;
  }
  return { ...current, [id]: frame };
}

export function useTourFrames(): Partial<Record<TourTargetId, TourFrame>> {
  return useContext(TourContext)?.frames ?? {};
}

/**
 * Marks a control as something the tour can point at.
 *
 * Spread onto the view: `<Pressable {...useTourTarget('mic')} />`. Outside a
 * `TourProvider` it is inert, which is what lets `HomeMic` carry it without the
 * component's own tests needing to know the tour exists.
 *
 * The measurement is taken in `onLayout` but not *from* it: that event reports
 * a frame relative to the parent, and the overlay needs the window. It is also
 * deferred a frame — on Android a `measureInWindow` issued inside the layout
 * pass that triggered it answers with zeroes often enough to matter, and a zero
 * frame draws a ring in the top-left corner of the screen.
 */
export function useTourTarget(id: TourTargetId) {
  const context = useContext(TourContext);
  const ref = useRef<View | null>(null);
  const mounted = useRef(false);
  const frame = useRef<number | null>(null);
  /*
   * A measurement that arrives before this component has finished mounting.
   *
   * `onLayout` fires inside the commit, and the frame it schedules can land
   * while React is still mounting the tree — which is a warning
   * ("Can't perform a React state update on a component that hasn't mounted
   * yet") and, worse, a *lost* frame if it is simply dropped: the layout is
   * settled, so nothing will fire again and that target has no spotlight for
   * the rest of the session. So it is held and flushed on mount instead.
   */
  const early = useRef<TourFrame | null>(null);
  /*
   * The context, in a ref, and this is not a micro-optimisation.
   *
   * Its value is a new object on every reported frame and every change of what
   * the walk is doing — so an effect keyed on it is torn down and rebuilt
   * constantly, and this one's teardown *cancels the pending measurement*. On
   * home nothing else moves while the frames settle, so it never showed. In the
   * menu it was fatal: opening the sheet sets the walk, which replaced the
   * context, which cancelled the animation frame every row had just scheduled —
   * and `onLayout` does not fire twice for a list that is not moving, so no row
   * ever reported itself and the ring had nothing to find. The menu opened
   * undressed, exactly as though none of this existed.
   */
  const latest = useRef(context);
  // In an effect, not in the render body: effects run at commit and the
  // measurement below is a frame later still, so this is always current by the
  // time anything reads it — and a ref written during render is a lint error
  // and, in a concurrent render that is thrown away, a lie.
  useEffect(() => {
    latest.current = context;
  });

  useEffect(() => {
    mounted.current = true;
    if (early.current && latest.current) {
      latest.current.report(id, early.current);
      early.current = null;
    }
    return () => {
      mounted.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [id]);

  const onLayout = useCallback(
    (_event: LayoutChangeEvent) => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      // Deferred a frame: on Android a `measureInWindow` issued inside the
      // layout pass that triggered it answers with zeroes often enough to
      // matter, and a zero frame draws a spotlight in the top-left corner.
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        ref.current?.measureInWindow((x, y, width, height) => {
          if (!width || !height) return;
          const context = latest.current;
          if (!context) return;
          if (!mounted.current) {
            early.current = { x, y, width, height };
            return;
          }
          context.report(id, { x, y, width, height });
        });
      });
    },
    [id],
  );

  /*
   * A callback ref rather than the object, so the node reaches the context as
   * well. Stable, or React would detach and reattach it on every render.
   */
  return { ref, onLayout, collapsable: false as const };
}
