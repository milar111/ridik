import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Card, Divider, Screen, Section, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

type Entry = {
  href: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
};

/**
 * Everything that is not one of the five tabs.
 *
 * Checklists deliberately do not appear here: they already live behind the
 * Notes tab's Lists switch, and two doors into one room is how a hub stops
 * being navigable. Setup — your week, places — moved into Settings, which is
 * where people look for things they configure once.
 */
const GROUPS: { title: string; entries: Entry[] }[] = [
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
    title: 'App',
    entries: [
      { href: '/settings', icon: 'settings-outline', label: 'Settings', hint: 'Voice, calendar, your data' },
    ],
  },
];

export default function MoreScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();

  return (
    <Screen title="More">
      {GROUPS.map((group) => (
        <Section key={group.title} title={group.title}>
          <Card padded={false}>
            {group.entries.map((entry, i) => (
              <View key={entry.href}>
                {i > 0 ? <Divider inset={48} /> : null}
                <Card
                  padded={false}
                  onPress={() => router.push(entry.href as never)}
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
