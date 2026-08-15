/**
 * The paywall.
 *
 * Ridik is useful without a plan — every note, task, timer and habit is local
 * and stays free. What a plan buys is the assistant: the part that costs money
 * to run because every sentence is a call to a model. This screen says that
 * plainly instead of listing features, because "unlock premium" tells nobody
 * what they are buying.
 *
 * Prices come from the store, never from here. A hardcoded "£4.99" is wrong in
 * every other currency, wrong after any price change, and is grounds for
 * rejection in both review processes.
 */
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useEntitlement, usePurchasePlan, useRestorePurchases } from '@/hooks/useBilling';
import { useTheme } from '@/ui/ThemeProvider';
import { Button, Card, Screen, Txt, useToast } from '@/ui/components';

/** What the assistant actually does that nothing else here does. */
const WHAT_YOU_GET = [
  'Talk instead of tap — one sentence becomes an event, a task and a reminder',
  'It knows your timetable, so "homework for Friday" lands on the right day',
  'Travel time blocked before anything you have to get to',
  'A briefing that reads your day back to you',
];

export default function PlansScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const entitlement = useEntitlement();
  const purchase = usePurchasePlan();
  const restore = useRestorePurchases();

  const active = entitlement.data?.active ?? false;

  return (
    <Screen back title="The assistant">
      <Txt variant="body" tone="secondary">
        Everything you have written stays yours and stays free. A plan pays for the part that
        listens and understands.
      </Txt>

      <Card style={{ gap: spacing.md }}>
        {WHAT_YOU_GET.map((line) => (
          <View key={line} style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
            <Ionicons name="checkmark" size={17} color={colors.accent} />
            <Txt variant="body" style={{ flex: 1 }}>
              {line}
            </Txt>
          </View>
        ))}
      </Card>

      {active ? (
        <Card accent={colors.success}>
          <Txt variant="bodyStrong">You are already subscribed.</Txt>
        </Card>
      ) : (
        <View style={{ gap: spacing.sm }}>
          <Button
            label="Monthly"
            variant="primary"
            loading={purchase.isPending}
            onPress={() =>
              purchase.mutate('monthly', {
                onSuccess: (result) => {
                  if (result.active) {
                    toast.show({ message: 'You are subscribed', tone: 'success' });
                    router.back();
                  }
                },
                onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
              })
            }
          />
          <Button
            label="Yearly"
            loading={purchase.isPending}
            onPress={() =>
              purchase.mutate('yearly', {
                onSuccess: (result) => {
                  if (result.active) {
                    toast.show({ message: 'You are subscribed', tone: 'success' });
                    router.back();
                  }
                },
                onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
              })
            }
          />
          {/* Required by both stores, and it has to be reachable without paying. */}
          <Button
            label="Restore purchases"
            variant="ghost"
            loading={restore.isPending}
            onPress={() =>
              restore.mutate(undefined, {
                onSuccess: (result) =>
                  toast.show({
                    message: result.active ? 'Plan restored' : 'Nothing to restore',
                    tone: result.active ? 'success' : 'neutral',
                  }),
                onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
              })
            }
          />
        </View>
      )}

      <Txt variant="caption" tone="tertiary" style={{ borderRadius: radius.sm }}>
        Billed through your app store account. Cancel there at any time — Ridik cannot cancel it for
        you, and neither can anyone else.
      </Txt>
    </Screen>
  );
}
