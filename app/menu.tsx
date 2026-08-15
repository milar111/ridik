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
import { Ionicons } from '@expo/vector-icons';

import { Card, Divider, Screen, Section, Txt } from '@/ui/components';
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
      { href: '/settings', icon: 'person-circle-outline', label: 'Profile', hint: 'Your plan, your data' },
    ],
  },
];

export default function MenuScreen() {
  const nav = useNavigateOnce();
  const { colors, spacing } = useTheme();

  return (
    // Default bottom clearance, not none: the floating mic comes back on every
    // screen that is not home, and the last row has to stay clear of it.
    <Screen title="Menu">
      {GROUPS.map((group) => (
        <Section key={group.title} title={group.title}>
          <Card padded={false}>
            {group.entries.map((entry, i) => (
              <View key={entry.href}>
                {i > 0 ? <Divider inset={48} /> : null}
                <Card
                  padded={false}
                  // Replace, not push: the menu is a junction, not a step. Back
                  // from Tasks should reach home, not the list you came through.
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
      ))}
    </Screen>
  );
}
