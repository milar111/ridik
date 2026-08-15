/**
 * The paywall, and the subscription's own screen once there is one.
 *
 * One route with two states rather than two screens: what you want to know
 * before buying and what you want to know after are the same facts — what it
 * costs, when it charges, how to stop.
 *
 * Prices always come from the store, never from here. A hardcoded "£4.99" is
 * wrong in every other currency, wrong the day after a price change, and is
 * grounds for rejection in both review processes.
 *
 * Cancelling is a link out, and that is not laziness: only the store can end a
 * subscription it is billing, and an in-app "Cancel" that merely opened the
 * same link while looking like it did the work would be a lie.
 */
import { View } from 'react-native';
import { Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { now } from '@/core/clock';
import { formatDayHeading } from '@/core/time';
import { useEntitlement, usePlans, usePurchasePlan, useRestorePurchases } from '@/hooks/useBilling';
import {
  describePlan,
  describeRenewal,
  manageSubscriptionUrl,
  FREE,
  type Entitlement,
} from '@/services/billing/entitlement';
import { useTheme } from '@/ui/ThemeProvider';
import { Badge, Button, Card, Divider, Screen, Txt, useToast } from '@/ui/components';

/** What the plan buys that the free app does not do. */
const WHAT_YOU_GET = [
  'Talk instead of tap — one sentence becomes an event, a task and a reminder',
  'It knows your timetable, so "homework for Friday" lands on the right day',
  'Travel time blocked before anything you have to get to',
  'A briefing that reads your day back to you',
];

export default function PlansScreen() {
  const entitlement = useEntitlement();
  const plan = entitlement.data ?? FREE;

  return (
    <Screen back title={plan.active ? 'Your plan' : 'The assistant'}>
      {plan.active ? <Subscribed plan={plan} /> : <Offer />}
    </Screen>
  );
}

/* -------------------------------------------------------------- subscribed */

function Subscribed({ plan }: { plan: Entitlement }) {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const manage = manageSubscriptionUrl();
  const at = now();

  return (
    <>
      <Card style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Txt variant="title">{describePlan(plan)}</Txt>
          {plan.inGracePeriod ? <Badge label="Payment failed" tone="danger" /> : null}
          {plan.store === 'sandbox' ? <Badge label="Sandbox" tone="warning" /> : null}
        </View>
        <Txt variant="body" tone="secondary">
          {describeRenewal(plan, (epoch) => formatDayHeading(epoch, undefined, at))}
        </Txt>
      </Card>

      <Card padded={false}>
        <Fact
          label={plan.willRenew ? 'Next charge' : 'Access ends'}
          value={plan.renewsAt === null ? 'Unknown' : formatDayHeading(plan.renewsAt, undefined, at)}
        />
        <Divider />
        <Fact
          label="Subscribed since"
          value={plan.since === null ? 'Unknown' : formatDayHeading(plan.since, undefined, at)}
        />
        <Divider />
        <Fact label="Billed by" value={BILLED_BY[plan.store ?? 'sandbox']} />
      </Card>

      {/* The store keeps the receipts, not Ridik. Sending someone to the list
          they can actually act on beats a copy of it that cannot refund. */}
      <Card style={{ gap: spacing.sm }}>
        <Txt variant="bodyStrong">Payments and receipts</Txt>
        <Txt variant="caption" tone="secondary">
          {RECEIPTS_IN[plan.store ?? 'sandbox']} Ridik never sees your card and cannot bill you
          itself.
        </Txt>
        {manage ? (
          <Button
            label={plan.willRenew ? 'Manage or cancel' : 'Resubscribe'}
            variant="primary"
            onPress={() =>
              void Linking.openURL(manage).catch(() =>
                toast.show({ message: 'Could not open the store.', tone: 'danger' }),
              )
            }
          />
        ) : null}
      </Card>

      <Txt variant="caption" tone="tertiary">
        Cancelling stops the next charge. You keep the assistant until the date above, and
        everything you have written stays yours either way.
      </Txt>
    </>
  );
}

const BILLED_BY: Record<NonNullable<Entitlement['store']>, string> = {
  'app-store': 'App Store',
  'play-store': 'Google Play',
  sandbox: 'this device (sandbox)',
};

/**
 * A whole sentence per store rather than a name dropped into a template. The
 * template read "lives in your this device (sandbox) account", which is the
 * usual result of pretending every value fits the same slot.
 */
const RECEIPTS_IN: Record<NonNullable<Entitlement['store']>, string> = {
  'app-store': 'Every charge, invoice and refund lives in your App Store account.',
  'play-store': 'Every charge, invoice and refund lives in your Google Play account.',
  sandbox: 'Nothing was charged — this plan only exists on this device.',
};

function Fact({ label, value }: { label: string; value: string }) {
  const { spacing } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: spacing.md,
        gap: spacing.md,
      }}
    >
      <Txt variant="body" tone="secondary">
        {label}
      </Txt>
      <Txt variant="bodyStrong">{value}</Txt>
    </View>
  );
}

/* ------------------------------------------------------------------- offer */

function Offer() {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const plans = usePlans();
  const purchase = usePurchasePlan();
  const restore = useRestorePurchases();

  const available = plans.data ?? [];

  return (
    <>
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

      {plans.isLoading && available.length === 0 ? (
        <Txt variant="caption" tone="tertiary">
          Loading prices from the store…
        </Txt>
      ) : available.length === 0 ? (
        <Card accent={colors.warning}>
          <Txt variant="bodyStrong" tone="warning">
            No plans available
          </Txt>
          <Txt variant="caption" tone="secondary">
            The store did not return anything to sell. On a simulator that is expected until the
            products exist in App Store Connect and Play Console.
          </Txt>
        </Card>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {available.map((option) => (
            <Button
              key={option.id}
              label={`${option.title} · ${option.price}`}
              variant={option.id === 'monthly' ? 'primary' : 'secondary'}
              loading={purchase.isPending}
              onPress={() =>
                purchase.mutate(option.id, {
                  onSuccess: (result) => {
                    if (result.active) toast.show({ message: 'You are subscribed', tone: 'success' });
                  },
                  onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                })
              }
            />
          ))}
        </View>
      )}

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

      <Txt variant="caption" tone="tertiary">
        Billed through your app store account and renewed automatically until you cancel there.
        Ridik never sees your card.
      </Txt>
    </>
  );
}
