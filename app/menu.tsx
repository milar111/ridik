/**
 * Every screen in the app, on one page.
 *
 * This replaced a five-tab bar and a "More" hub that between them showed six
 * destinations and hid seven. A hamburger is not a worse tab bar here — the app
 * is voice-first, so no destination is used often enough to earn permanent
 * chrome, and the ones you do want are easier to find in a list you can read
 * than behind icons you have to recognise.
 *
 * Ordered by how the day tends to go, not alphabetically and not by how the
 * code is grouped: what is happening, what you owe, what you are keeping track
 * of, and then the things you set once.
 */
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { Card, Divider, Screen, Section, Txt } from '@/ui/components';
import { useStaggeredEntry } from '@/ui/motionHooks';
import { useTheme } from '@/ui/ThemeProvider';
import { useNavigateOnce } from '@/ui/useNavigateOnce';

type Entry = {
  href: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
};

const GROUPS: { title: string; entries: Entry[] }[] = [
  {
    title: 'Your day',
    entries: [
      { href: '/today', icon: 'today-outline', label: 'Today', hint: 'Agenda, due, habits, logged' },
      { href: '/calendar', icon: 'calendar-outline', label: 'Calendar', hint: 'Events and classes' },
      { href: '/tasks', icon: 'checkbox-outline', label: 'Tasks', hint: 'Everything outstanding' },
    ],
  },
  {
    title: 'Keep',
    entries: [
      { href: '/notes', icon: 'document-text-outline', label: 'Notes', hint: 'Notes and lists' },
      { href: '/projects', icon: 'albums-outline', label: 'Projects', hint: 'Anything with parts' },
    ],
  },
  {
    title: 'Track',
    entries: [
      { href: '/focus', icon: 'timer-outline', label: 'Focus', hint: 'Timers and breaks' },
      { href: '/habits', icon: 'flame-outline', label: 'Habits', hint: 'Streaks and consistency' },
      { href: '/ledger', icon: 'wallet-outline', label: 'Money', hint: 'What you spent' },
      { href: '/people', icon: 'people-outline', label: 'People', hint: 'Commitments and history' },
      { href: '/activity', icon: 'pulse-outline', label: 'Activity', hint: 'What you got done' },
    ],
  },
  {
    // Things you set once and then forget. They used to live inside Settings,
    // which is where nobody looked for them: they are screens with content, not
    // preferences, and they belong beside the other screens.
    title: 'Set up',
    entries: [
      {
        href: '/curriculum',
        icon: 'school-outline',
        label: 'Your week',
        hint: 'Classes and anything that repeats',
      },
      {
        href: '/places',
        icon: 'location-outline',
        label: 'Places',
        hint: 'Home, the lab — for arriving reminders',
      },
    ],
  },
  {
    title: 'App',
    entries: [
      {
        href: '/history',
        icon: 'chatbubble-ellipses-outline',
        label: 'History',
        hint: 'What Ridik heard and what it did',
      },
      // Beside History because they are the same promise twice: that record is
      // what you said, this one is what the app counted about itself, and both
      // are here so neither has to be taken on faith.
      {
        href: '/usage',
        icon: 'bar-chart-outline',
        label: 'Usage',
        hint: 'What Ridik counts about itself',
      },
      { href: '/settings', icon: 'person-circle-outline', label: 'Profile', hint: 'Your plan, your data' },
    ],
  },
];

export default function MenuScreen() {
  const nav = useNavigateOnce();
  const { colors, spacing } = useTheme();
  // Five groups, not thirteen rows. `GROUPS` is a constant, so a per-row wave
  // would be animating a fixed layout for its own sake — and with the cap at
  // four steps the last eight rows would land together anyway, which reads as
  // a stutter rather than a cascade. The headings are the list here.
  //
  // This screen is a sheet, but a *navigator* one — `presentation: 'modal'`,
  // not a React Native `Modal` — so it is still inside the root view and gets
  // the layout pass `entering` needs. The rule about layout animations in a
  // `Modal` is about the component, not about anything that looks like a sheet.
  const arrive = useStaggeredEntry({ from: 'below' });

  return (
    // Default bottom clearance, not none: the floating mic comes back on every
    // screen that is not home, and the last row has to stay clear of it.
    <Screen close title="Menu">
      {GROUPS.map((group, index) => (
        <Animated.View key={group.title} entering={arrive(index)}>
          <Section title={group.title}>
            <Card padded={false}>
              {group.entries.map((entry, i) => (
                <View key={entry.href}>
                  {i > 0 ? <Divider inset={48} /> : null}
                  <Card
                    padded={false}
                    // Replace, not push: the menu is a junction, not a step.
                    // Back from Tasks should reach home, not the list you came
                    // through.
                    onPress={() => nav.replace(entry.href as never)}
                    style={{ borderWidth: 0, backgroundColor: 'transparent' }}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: spacing.md,
                        paddingVertical: 12,
                        paddingHorizontal: spacing.md,
                      }}
                    >
                      <Ionicons name={entry.icon} size={20} color={colors.accent} />
                      <View style={{ flex: 1, gap: 1 }}>
                        <Txt variant="bodyStrong">{entry.label}</Txt>
                        <Txt variant="caption" tone="tertiary">
                          {entry.hint}
                        </Txt>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
                    </View>
                  </Card>
                </View>
              ))}
            </Card>
          </Section>
        </Animated.View>
      ))}
    </Screen>
  );
}
