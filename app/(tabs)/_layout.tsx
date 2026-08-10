import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/ui/ThemeProvider';
import { TAB_BAR_CONTENT_HEIGHT } from '@/ui/layout';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { VoiceDock } from '@/features/voice/VoiceDock';

type IconName = keyof typeof Ionicons.glyphMap;

const TABS: { name: string; title: string; icon: IconName; activeIcon: IconName }[] = [
  { name: 'index', title: 'Today', icon: 'today-outline', activeIcon: 'today' },
  { name: 'calendar', title: 'Calendar', icon: 'calendar-outline', activeIcon: 'calendar' },
  { name: 'tasks', title: 'Tasks', icon: 'checkbox-outline', activeIcon: 'checkbox' },
  { name: 'notes', title: 'Notes', icon: 'document-text-outline', activeIcon: 'document-text' },
  { name: 'projects', title: 'Projects', icon: 'albums-outline', activeIcon: 'albums' },
];

export default function TabsLayout() {
  const { colors, typography } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <ErrorBoundary label="tabs">
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textTertiary,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            borderTopWidth: StyleSheet.hairlineWidth,
            paddingTop: 4,
            // Android gesture navigation draws over the bottom edge, so the inset
            // has to be added rather than assumed away by a fixed height.
            paddingBottom: insets.bottom,
            height: TAB_BAR_CONTENT_HEIGHT + insets.bottom,
          },
          tabBarLabelStyle: { ...typography.micro, fontWeight: '500' },
          tabBarItemStyle: { paddingVertical: 2 },
        }}
      >
        {TABS.map((tab) => (
          <Tabs.Screen
            key={tab.name}
            name={tab.name}
            options={{
              title: tab.title,
              tabBarIcon: ({ color, focused, size }) => (
                <Ionicons name={focused ? tab.activeIcon : tab.icon} size={size - 2} color={color} />
              ),
            }}
          />
        ))}
      </Tabs>
      <VoiceDock />
    </ErrorBoundary>
  );
}
