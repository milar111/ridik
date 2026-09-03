/**
 * The first run: what this is, how it works, what it needs, where words go.
 *
 * Four steps, and the last one is `ConsentScreen` unchanged. That is deliberate
 * rather than lazy — the disclosure is legally load-bearing (it names every
 * recipient, and `consent-screen.test.tsx` enumerates the `*_PROVIDER` exports
 * to prove it), so this flow wraps it rather than reimplementing any part of
 * it. Answering it is also what closes the gate, which is why it goes last: the
 * decision that ends onboarding should be the consequential one, not a
 * permission dialog somebody tapped past.
 *
 * Permissions come *before* consent for the same reason. The microphone is
 * needed whichever way the disclosure is answered — declining leaves a working
 * app whose offline matcher still files a spoken sentence — so asking for it
 * after would make it look conditional on saying yes to Google.
 *
 * Every ask is skippable and nothing is asked twice. A permission already
 * granted shows as done rather than as a button that opens nothing, and one the
 * OS has hard-blocked says so instead of offering a dialog that will never
 * appear again — the same rule the Settings screen follows.
 */
import { useState } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useReducedMotion } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConsentScreen } from '@/features/consent/ConsentScreen';
import { usePermissions, useRequestPermission, type PermissionId } from '@/hooks/useSystem';
import { useFontsReady } from '@/ui/fonts';
import { HeatField } from '@/ui/HeatField';
import { useTheme } from '@/ui/ThemeProvider';
import { Button, Txt } from '@/ui/components';

/** What the three panels say, in the order somebody meets them. */
const PANELS = [
  {
    key: 'what',
    icon: 'mic' as const,
    eyebrow: 'RIDIK',
    title: 'Say it once.',
    body:
      'One screen and one microphone. Tell Ridik what is happening and it files the ' +
      'event, the task, the note or the number — in the words you already used.',
  },
  {
    key: 'how',
    icon: 'checkmark-done-outline' as const,
    eyebrow: 'HOW IT WORKS',
    title: 'You see it before it happens.',
    body:
      'Everything you say comes back on screen first, so a mis-heard word is a ' +
      'keystroke rather than a wrong appointment. Afterwards the last thing Ridik ' +
      'did sits under the mic, with an undo.',
  },
  {
    key: 'yours',
    icon: 'phone-portrait-outline' as const,
    eyebrow: 'WHERE IT LIVES',
    title: 'On your phone.',
    body:
      'No account, no sign-up. Your notes, tasks and events are in a database on ' +
      'this device, and you can export or back up all of it at any time.',
  },
] as const;

/**
 * What is asked for, and what each one is *for*.
 *
 * Named by consequence rather than by API. "Notifications" is a system noun;
 * "so a reminder can actually reach you" is the reason somebody would say yes,
 * and a permission screen that lists capabilities without consequences is how
 * an install ends up with everything denied.
 *
 * Location is absent on purpose. It is the one permission with a genuinely
 * narrow use here — a reminder that fires when you arrive somewhere — and it is
 * asked for on the Places screen at the moment a reminder cannot be watched
 * without it. Asking on a first run, before anybody has made one, is how a
 * permission gets denied for ever by somebody who would have granted it later.
 */
const ASKS: {
  id: PermissionId;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  why: string;
  required?: boolean;
}[] = [
  {
    id: 'microphone',
    icon: 'mic-outline',
    label: 'Microphone',
    why: 'The whole app is a microphone. Without it nothing can be said.',
    required: true,
  },
  {
    id: 'notifications',
    icon: 'notifications-outline',
    label: 'Notifications',
    why: 'So a reminder can reach you when the app is closed.',
  },
  {
    id: 'calendar',
    icon: 'calendar-outline',
    label: 'Calendar',
    why: 'To show what is already on your day, and put what you say beside it.',
  },
];

export function WelcomeFlow() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const fontsReady = useFontsReady();
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);

  /*
    Read here rather than inside the step, because the footer button depends on
    the answer: nothing may leave this screen until all three are granted.

    Stated plainly because it is a real trade and it is the app owner's call:
    requiring notifications is the part App Review is most likely to argue with
    (Guideline 5.1.1 wants an app to function when a non-core permission is
    refused), and a permission the OS has *hard-blocked* can never be granted
    from a dialog again. The second of those would be a bricked install, so
    `blocked` is not treated as a dead end — the row switches to Open Settings,
    which is the one place it can still be granted. What is deliberately not
    offered is a way past.
  */
  const permissions = usePermissions();
  const request = useRequestPermission();
  const missing = ASKS.filter((ask) => !isGranted(permissions.data?.[ask.id]?.level));
  const ready = permissions.isSuccess && missing.length === 0;

  // Nothing may lay out text before the faces resolve. Android caches text
  // measurements and this is the first screen a new install ever draws, so a
  // paragraph measured in the fallback face stays wrong for the whole session.
  if (!fontsReady) return <View style={[styles.root, { backgroundColor: colors.bg }]} />;

  // The disclosure ends the flow, and answering it is what closes the gate.
  if (step > PANELS.length) return <ConsentScreen />;

  const panel = step < PANELS.length ? PANELS[step] : null;

  return (
    <View style={styles.root} testID="welcome-flow">
      {/* The app's own ground, not a plain card: the first thing a new install
          sees should be unmistakably the same object as the home screen it is
          about to become. */}
      <HeatField state="idle" originY={0.42} />

      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + spacing.xl,
            paddingBottom: insets.bottom + spacing.lg,
            paddingHorizontal: spacing.lg,
          },
        ]}
      >
        <Progress step={step} total={PANELS.length + 1} />

        {panel ? (
          <Animated.View
            key={panel.key}
            entering={reduced ? undefined : FadeIn.duration(260)}
            exiting={reduced ? undefined : FadeOut.duration(120)}
            style={{ gap: spacing.md }}
          >
            <View style={[styles.mark, { backgroundColor: colors.accentMuted }]}>
              <Ionicons name={panel.icon} size={26} color={colors.accent} />
            </View>
            <Txt variant="eyebrow" tone="tertiary">
              {panel.eyebrow}
            </Txt>
            <Txt variant="display">{panel.title}</Txt>
            <Txt variant="body" tone="secondary">
              {panel.body}
            </Txt>
          </Animated.View>
        ) : (
          <PermissionStep permissions={permissions} request={request} />
        )}
      </ScrollView>

      <View
        style={[
          styles.footer,
          { paddingHorizontal: spacing.lg, paddingBottom: insets.bottom + spacing.md },
        ]}
      >
        {/*
          On the permission step the button is the gate, and it says so by being
          *off* rather than by changing into a sentence. A first version made the
          label the explanation — "3 still needed", with a padlock — which reads
          as a different control appearing where the button was, and the padlock
          on a full-bleed primary looks like a paywall. `Button` already dims to
          0.45 when disabled; the colour coming back is the whole signal, and it
          needs no words because the three rows above it are the explanation.
        */}
        <Button
          label={panel ? 'Next' : 'Continue'}
          variant="primary"
          icon="arrow-forward"
          disabled={!panel && !ready}
          accessibilityLabel={
            panel || ready
              ? undefined
              : // A dim button says nothing to a screen reader, and this is the
                // one control on the screen. `disabled` is announced; *why* is
                // not, so the label carries it.
                `Continue. Not yet available — ${missing.map((ask) => ask.label).join(', ')} still needed.`
          }
          fullWidth
          onPress={() => setStep((current) => current + 1)}
        />
        {/*
          One control, deliberately. There was a Skip under this, on the
          reasoning that somebody reinstalling should not read three panels
          again — which does not survive the arithmetic: it is three taps, on a
          first run, and it landed on the permission step, which cannot be
          skipped either. A second button under the primary one is a *choice*
          where the screen wanted an instruction, on the one screen in the app
          whose job is to be followed rather than navigated.
        */}
      </View>
    </View>
  );
}

/** Granted, or granted-enough: location's "while using" counts, a mic's does not. */
function isGranted(level: string | undefined): boolean {
  return level === 'granted' || level === 'partial';
}

/** Where you are, drawn as the app's own heat cells rather than as dots. */
function Progress({ step, total }: { step: number; total: number }) {
  const { cells, colors, spacing } = useTheme();
  return (
    <View
      style={[styles.progress, { marginBottom: spacing.xl }]}
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${step + 1} of ${total}`}
    >
      {Array.from({ length: total }, (_, index) => (
        <View
          key={index}
          style={[
            styles.pip,
            {
              backgroundColor: index <= step ? colors.accent : cells.cold,
              // The one you are on is longer, not just brighter: a colour
              // difference alone is invisible to a good share of people.
              width: index === step ? 22 : 8,
            },
          ]}
        />
      ))}
    </View>
  );
}

function PermissionStep({ permissions, request }: {
  permissions: ReturnType<typeof usePermissions>;
  request: ReturnType<typeof useRequestPermission>;
}) {
  const { colors, spacing } = useTheme();

  return (
    <View style={{ gap: spacing.md }}>
      <View style={[styles.mark, { backgroundColor: colors.accentMuted }]}>
        <Ionicons name="key-outline" size={26} color={colors.accent} />
      </View>
      <Txt variant="eyebrow" tone="tertiary">
        WHAT IT NEEDS
      </Txt>
      <Txt variant="display">Three permissions.</Txt>
      <Txt variant="body" tone="secondary">
        Ridik needs all three to do what it does: hear you, reach you when the app is closed,
        and put what you say beside what is already on your day.
      </Txt>

      <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
        {ASKS.map((ask) => (
          <AskRow
            key={ask.id}
            ask={ask}
            level={permissions.data?.[ask.id]?.level}
            busy={request.isPending && request.variables === ask.id}
            onAsk={() => request.mutate(ask.id)}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * One permission, as a card the same weight as everything else on the screen.
 *
 * It was a 12pt-padded row with the word ALLOW set in `micro` at the end — a
 * 11pt tracked label doing the job of a button, on a screen whose own footer
 * control is a full-width 14pt one. Next to a 34pt heading and a full-bleed
 * primary button it read as a caption you could not press, which is exactly
 * what somebody reported. The action is a real `Button` now, so it is the same
 * object at the same size as every other action in the app.
 */
function AskRow({
  ask,
  level,
  busy,
  onAsk,
}: {
  ask: (typeof ASKS)[number];
  level: string | undefined;
  busy: boolean;
  onAsk: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const granted = isGranted(level);
  /*
    A permission the OS has hard-blocked raises no dialog ever again, so a
    button that asks for it is a button that does nothing. `openSettings` is the
    only place it can still be granted, and offering it is what stops a required
    permission becoming an install with no way forward.
  */
  const blocked = level === 'blocked';

  return (
    <View
      style={[
        styles.ask,
        {
          backgroundColor: colors.surface,
          borderRadius: radius.md,
          padding: spacing.md,
          /*
            A granted row goes *quiet*, it does not light up.

            It had a green tick in a green ring, which is the convention
            everywhere and wrong here: there is no green in this palette. One
            colour at four opacities is the whole visual system (see the note on
            `EmberOption`), and a success green next to it reads exactly the way
            a true grey does — as a bug. Losing the Allow button is already the
            signal that a row is finished; the only paint it needs is less of it.

            Blocked keeps a border because it is the one row still asking for
            something, and `warning` is a member of this palette rather than a
            visitor to it.
          */
          borderColor: blocked ? colors.warning : 'transparent',
          opacity: granted ? 0.62 : 1,
        },
      ]}
      accessible
      accessibilityLabel={
        granted
          ? `${ask.label}, allowed`
          : blocked
            ? `${ask.label}, blocked. Open system settings to allow it.`
            : `${ask.label}. ${ask.why}`
      }
    >
      <View
        style={[styles.askGlyph, { backgroundColor: colors.accentMuted, borderRadius: radius.sm }]}
      >
        {/* The tick is the ember too. Its job is to say "done", and a done row
            is not a different kind of object from an undone one. */}
        <Ionicons name={granted ? 'checkmark' : ask.icon} size={19} color={colors.accent} />
      </View>

      <View style={{ flex: 1, gap: 3 }}>
        <Txt variant="bodyStrong">{ask.label}</Txt>
        <Txt variant="caption" tone="secondary">
          {granted ? 'Allowed' : blocked ? 'Blocked in system settings' : ask.why}
        </Txt>
      </View>

      {granted ? null : (
        /* Wrapped, because `Button` sets `alignSelf: 'flex-start'` to hug its
           label in a column — and on a *row* that declaration addresses the
           vertical and pins it to the top. See the note in `AGENTS.md`. */
        <View style={styles.askAction}>
          <Button
            label={blocked ? 'Settings' : 'Allow'}
            size="sm"
            variant="primary"
            loading={busy}
            accessibilityLabel={blocked ? `Open settings for ${ask.label}` : `Allow ${ask.label}`}
            onPress={() => (blocked ? void Linking.openSettings() : onAsk())}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill },
  content: { flexGrow: 1, justifyContent: 'center' },
  footer: {},
  mark: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  progress: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  pip: { height: 8, borderRadius: 4 },
  // Taller and with a real trailing control, so a permission row weighs the
  // same as the buttons and headings around it.
  ask: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, minHeight: 72 },
  askGlyph: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  askAction: { justifyContent: 'center' },
});
