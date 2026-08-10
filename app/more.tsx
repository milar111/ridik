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

const GROUPS: { title: string; entries: Entry[] }[] = [
  {
    title: 'Capture',
    entries: [
      { href: '/checklists', icon: 'list-outline', label: 'Checklists', hint: 'Shopping, packing, BOMs' },
      { href: '/activity', icon: 'pulse-outline', label: 'Activity log', hint: 'What you got done' },
      { href: '/focus', icon: 'timer-outline', label: 'Focus sessions', hint: 'Timers and breaks' },
    ],
  },
  {
    title: 'Track',
    entries: [
      { href: '/habits', icon: 'flame-outline', label: 'Habits', hint: 'Streaks and consistency' },
      { href: '/ledger', icon: 'wallet-outline', label: 'Ledger', hint: 'Spending by voice' },
      { href: '/people', icon: 'people-outline', label: 'People', hint: 'Commitments and history' },
    ],
  },
  {
    title: 'Setup',
    entries: [
      { href: '/curriculum', icon: 'school-outline', label: 'Weekly programme', hint: 'Classes and recurring slots' },
      { href: '/places', icon: 'location-outline', label: 'Places', hint: 'Location reminders' },
      { href: '/settings', icon: 'settings-outline', label: 'Settings', hint: 'Voice, sync, account' },
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
