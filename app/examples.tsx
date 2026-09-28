/**
 * "What can I say?", as a place you can go back to.
 *
 * The tour on home points at this screen and stops there: it shows where things
 * are, and this is the list of what to say once you know. The question does not
 * arrive on day one, when somebody is being shown things — it arrives on day
 * three, when they want to do something they have not done before and their
 * alternative is to guess. A guess is a request, and on a free install a
 * request comes out of a lifetime trial.
 *
 * It is also where the tour is restarted, rather than a row on Settings. Both
 * answer the same question — "how does this work?" — and somebody asking it is
 * already here; a "Replay tour" switch on the settings screen is a developer's
 * view of a flag, and Settings is the one screen in this app that has to earn
 * every row.
 */
import { ScrollView, View } from 'react-native';

import { PhraseList } from '@/features/onboarding/PhraseList';
import { useSetting } from '@/hooks/useSettings';
import { Button, MIC_CLEARANCE, Screen, Txt } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';
import { useNavigateOnce } from '@/ui/useNavigateOnce';

export default function ExamplesScreen() {
  const { spacing } = useTheme();
  const nav = useNavigateOnce();
  const seen = useSetting('tourSeen');

  return (
    <Screen back title="What to say" subtitle="Say it however you like — these are just examples.">
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ gap: spacing.sm, paddingBottom: MIC_CLEARANCE }}>
          {/*
            `replace`, not `push`: the tour runs on home, and pushing would
            leave this screen underneath it so that Back out of the tour lands
            back on the list it was started from.
          */}
          <Button
            testID="examples-replay-tour"
            label="Show me around"
            icon="navigate-outline"
            variant="secondary"
            fullWidth
            onPress={() => {
              seen.set(false);
              nav.replace('/');
            }}
          />
          <PhraseList />
          <Txt variant="caption" tone="tertiary" style={{ paddingHorizontal: 2 }}>
            Ridik shows you what it heard before anything is sent, so a mis-heard word costs a
            keystroke rather than a wrong appointment.
          </Txt>
        </View>
      </ScrollView>
    </Screen>
  );
}
