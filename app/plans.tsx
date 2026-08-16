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
import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { now } from '@/core/clock';
import { formatDayHeading } from '@/core/time';
import {
  useCredits,
  useEntitlement,
  usePlanMarketing,
  usePlans,
  usePurchasePlan,
  usePurchaseTopUp,
  useRestorePurchases,
  useTopUpPrice,
} from '@/hooks/useBilling';
import {
  NO_CREDITS,
  creditsRemaining,
  describeCredits,
  describeTopUp,
} from '@/services/billing/credits';
import {
  describeAllowance,
  describeBillingPeriod,
  describePlan,
  describePlanAllowance,
  HIGHLIGHTED_PLAN,
  describeRenewal,
  isYearly,
  manageSubscriptionUrl,
  tierFor,
  FREE,
  type Entitlement,
  type Plan,
  type PlanTier,
} from '@/services/billing/entitlement';
import { privacyPolicyUrl, termsUrl } from '@/services/legal';
import {
  annualPitch,
  annualSaving,
  monthlyPitch,
  money,
  monthlyPrice,
  planFor,
  plansBilling,
  type Cadence,
} from '@/services/billing/money';
import { useTheme } from '@/ui/ThemeProvider';
import { AnimatedPressable, usePressScale } from '@/ui/motionHooks';
import { elevate } from '@/ui/shadow';
import { Badge, Button, Card, Divider, Screen, Txt, useToast } from '@/ui/components';

/**
 * The fallback selling points. The store's own offering metadata wins when it
 * has any, so the pitch can be reworded from a dashboard rather than a release
 * — but a paywall must never be blank because a network call failed.
 */
const WHAT_YOU_GET = [
  'Talk instead of tap — one sentence becomes an event, a task and a reminder',
  'It knows your timetable, so "homework for Friday" lands on the right day',
  'Travel time blocked before anything you have to get to',
  'A briefing waiting for you the first time you open the app',
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
  const period = describeBillingPeriod(plan);
  const allowance = describePlanAllowance(plan);

  return (
    <>
      <Card style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Txt variant="title">{describePlan(plan)}</Txt>
          {/* The title names the tier, so the cadence rides alongside it. The
              two used to be the same word and only the cadence was shown. */}
          {period ? <Badge label={period} tone="neutral" /> : null}
          {plan.inGracePeriod ? <Badge label="Payment failed" tone="danger" /> : null}
          {plan.store === 'sandbox' ? <Badge label="Sandbox" tone="warning" /> : null}
        </View>
        <Txt variant="body" tone="secondary">
          {describeRenewal(plan, (epoch) => formatDayHeading(epoch, undefined, at))}
        </Txt>
      </Card>

      <Card padded={false}>
        {/* What the money actually bought. The paywall promises an allowance
            and this screen never repeated it, so the one number a subscriber
            might want to check was only ever visible before paying. */}
        {allowance ? (
          <>
            <Fact label="Included" value={allowance} />
            <Divider />
          </>
        ) : null}
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

      <TopUp />

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

/**
 * A tier, as a thing you choose rather than a row you scan.
 *
 * One card per tier, not one per product. Four rows was four prices for two
 * things, and the reader's first job was working out which pairs were the same
 * plan — the billing period is a *setting*, so it belongs on a control, not in
 * the catalogue.
 *
 * The headline is always the cost per month, whichever way it bills. Comparing
 * $99.99 to $10.00 is comparing a year to a month, and every reader has to do
 * that division themselves before the ladder means anything; doing it for them
 * is the entire reason a yearly plan is worth offering. The total that will
 * actually be charged is stated underneath, in the store's own words.
 *
 * The price is the largest type on the card and set in the mono face, because
 * it is a figure you compare rather than a phrase you read — the same reason
 * the time on the home screen is a readout.
 */
function TierCard({
  plan,
  monthly,
  recommended,
  busy,
  onPress,
}: {
  plan: Plan;
  /** The same tier billed monthly, for the "or $X monthly" comparison. */
  monthly: Plan | null;
  recommended: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const press = usePressScale({ scale: 0.98, disabled: busy });

  const yearly = isYearly(plan.id);
  // The derived figure, or the store's own string when the store gave no
  // number to derive from. Never a guess: see `money.ts`.
  const headline = monthlyPrice(plan) ?? plan.price;
  const pitch = yearly ? annualPitch(plan, monthly) : monthlyPitch();

  return (
    <AnimatedPressable
      testID={`plan-${plan.tier}`}
      accessibilityRole="button"
      accessibilityLabel={`Subscribe to ${plan.title}, ${headline} per month. ${pitch}`}
      accessibilityState={{ busy }}
      disabled={busy}
      {...press.handlers}
      onPress={onPress}
      style={[
        {
          gap: spacing.sm,
          padding: spacing.lg,
          borderRadius: radius.lg,
          backgroundColor: colors.surface,
          // The recommended one is marked by a border in the accent rather than
          // a filled block: two filled cards side by side read as two primary
          // actions, which is the one thing a choice must not look like.
          borderWidth: recommended ? 2 : 1,
          borderColor: recommended ? colors.accent : colors.border,
          opacity: busy ? 0.6 : 1,
          ...elevate('card'),
        },
        press.style,
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Txt variant="bodyStrong" style={{ flex: 1 }}>
          {plan.title}
        </Txt>
        {recommended ? <Badge label="Best value" /> : null}
        {plan.note ? <Badge label={plan.note} tone="warning" /> : null}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs }}>
        <Txt variant="readout" style={{ fontSize: 30, lineHeight: 34 }}>
          {headline}
        </Txt>
        <Txt variant="caption" tone="secondary">
          / month
        </Txt>
      </View>

      {/* What is actually charged, and when. The one line on this screen that
          has to survive somebody reading it twice before paying. */}
      <Txt variant="caption" tone="tertiary">
        {pitch}
      </Txt>

      <Divider />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Ionicons name="mic" size={15} color={colors.accent} />
        <Txt variant="body" style={{ flex: 1 }}>
          {describeAllowance(plan.tier)}
        </Txt>
      </View>
      <Txt variant="caption" tone="tertiary">
        {ROUGHLY[plan.tier]}
      </Txt>
    </AnimatedPressable>
  );
}

/**
 * The allowance as a rate rather than a total.
 *
 * "250 a month" is a number people accept without picturing; "about eight a
 * day" is one they can check against yesterday. Deliberately approximate and
 * worded as such — nothing meters a day, and a reader who takes "8" literally
 * and speaks nine times has not broken anything.
 */
const ROUGHLY: Record<PlanTier, string> = {
  base: 'Roughly eight requests a day, every day of the month.',
  pro: 'Roughly thirty a day — for speaking to it all day, not just filing.',
};

/**
 * Monthly or yearly, for the whole page at once.
 *
 * A segmented control rather than a per-card choice: the question "how often
 * do I want to be charged" is asked once, and asking it twice invites the
 * answer that costs more by accident.
 */
function BillingToggle({
  cadence,
  onChange,
  saving,
}: {
  cadence: Cadence;
  onChange: (next: Cadence) => void;
  saving: number | null;
}) {
  const { colors, radius, spacing } = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        padding: 3,
        gap: 3,
        borderRadius: radius.pill,
        backgroundColor: colors.surfaceSunken,
      }}
    >
      {(['month', 'year'] as const).map((option) => {
        const active = option === cadence;
        return (
          <Pressable
            key={option}
            testID={`billing-${option}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={option === 'year' ? 'Billed yearly' : 'Billed monthly'}
            onPress={() => onChange(option)}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: spacing.xs,
              paddingVertical: spacing.sm,
              borderRadius: radius.pill,
              backgroundColor: active ? colors.surface : 'transparent',
              ...(active ? elevate('card') : null),
            }}
          >
            <Txt variant={active ? 'bodyStrong' : 'body'} tone={active ? 'primary' : 'secondary'}>
              {option === 'year' ? 'Yearly' : 'Monthly'}
            </Txt>
            {/* Only ever drawn from the store's own two numbers, and only when
                the year is genuinely cheaper — see `annualSaving`. */}
            {option === 'year' && saving != null ? (
              <Badge label={`Save ${saving}%`} tone="success" />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The top-up, and the balance it adds to.
 *
 * Under the plans and never above them, because it is the worse deal and
 * should look like it: 3¢ a request against 1¢ on Ridik Pro. It exists for the
 * month somebody overshoots, not as a cheaper way in, and putting it first
 * would sell it to people a plan would serve better.
 *
 * Drawn on the paywall *and* on the subscribed screen, because both can run
 * out — a spent trial and an exhausted month are the same problem to somebody
 * who just wants to say one more thing.
 */
function TopUp() {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const credits = useCredits();
  const price = useTopUpPrice();
  const buy = usePurchaseTopUp();

  const ledger = credits.data ?? NO_CREDITS;
  const left = creditsRemaining(ledger);
  // Formatted the same way the plan cards are. Passing the store's own string
  // straight through is what put "3,00 US$" on this button next to "$8.33" on
  // the card above it — both correct, both the same currency, and only one of
  // them looking deliberate. Falls back to the store's string when the store
  // gave no amount to format, because a real price beats a tidy blank.
  const listed = price.data ?? null;
  const cost =
    (listed?.amount != null ? money(listed.amount, listed.currency) : null) ??
    (listed?.price?.trim() ? listed.price : null);

  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Ionicons name="add-circle-outline" size={17} color={colors.accent} />
        <Txt variant="bodyStrong" style={{ flex: 1 }}>
          Need a few more?
        </Txt>
      </View>

      <Txt variant="caption" tone="secondary">
        {describeTopUp()} They are spent only once your plan or trial has run out, so buying one
        never wastes what you already have.
      </Txt>

      {/* Only when there is something to report. A row reading "0 left" on a
          screen for somebody who has never bought one is an error message for
          a mistake nobody made. */}
      {left > 0 ? (
        <Txt testID="credits-balance" variant="bodyStrong" tone="success">
          {describeCredits(ledger)}
        </Txt>
      ) : null}

      <Button
        testID="buy-topup"
        label={cost ? `Buy a top-up · ${cost}` : 'Buy a top-up'}
        variant="secondary"
        loading={buy.isPending}
        onPress={() =>
          buy.mutate(undefined, {
            onSuccess: () => toast.show({ message: 'Top-up added', tone: 'success' }),
            onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
          })
        }
      />
    </Card>
  );
}

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
  const marketing = usePlanMarketing();
  const purchase = usePurchasePlan();
  const restore = useRestorePurchases();

  const available = plans.data ?? [];
  const benefits = marketing.data?.benefits?.length ? marketing.data.benefits : WHAT_YOU_GET;

  /* Yearly first, because it is the badged row and the one the saving is for.
     A default that opened on monthly would make the discount something you had
     to go looking for. */
  const [cadence, setCadence] = useState<Cadence>('year');
  const shown = plansBilling(available, cadence);
  const monthlyFor = (tier: PlanTier) =>
    plansBilling(available, 'month').find((plan) => plan.tier === tier) ?? null;
  /* One badge for the page, from the tier the badge is on — both tiers are
     discounted by the same fraction, and two different percentages on one
     control would be a pricing table pretending to be a switch. */
  const saving = annualSaving(monthlyFor('pro'), planFor(available, HIGHLIGHTED_PLAN));
  // `HIGHLIGHTED_PLAN`, not a literal. This read `?? 'yearly'` — a plan id that
  // stopped existing when a plan became a tier AND a duration, so with no
  // dashboard metadata the badge matched nothing and every row rendered plain.
  // Typecheck could not catch it: comparing `PlanId` against `PlanId | 'yearly'`
  // is a legal comparison that is simply never true.
  // Compared by *tier*, not by id. Keyed on the id, the badge vanished the
  // moment the toggle moved to monthly — the highlighted plan is a yearly one,
  // so no monthly card matched it and the page lost its anchor on half its
  // states. The recommendation is which tier to buy; how often it bills is the
  // toggle's question, and it is asked separately for a reason.
  const highlight = marketing.data?.highlight ?? HIGHLIGHTED_PLAN;

  return (
    <>
      <Txt variant="body" tone="secondary">
        Everything you have written stays yours and stays free. A plan pays for the part that
        listens and understands.
      </Txt>

      <Card style={{ gap: spacing.md }}>
        {benefits.map((line) => (
          <View key={line} style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}>
            <Ionicons name="checkmark" size={17} color={colors.accent} />
            <Txt variant="body" style={{ flex: 1 }}>
              {line}
            </Txt>
          </View>
        ))}
      </Card>

      <BillingToggle cadence={cadence} onChange={setCadence} saving={saving} />

      {plans.isLoading && available.length === 0 ? (
        <Txt variant="caption" tone="tertiary">
          Loading prices from the store…
        </Txt>
      ) : shown.length === 0 ? (
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
          {shown.map((option) => (
            <TierCard
              key={option.id}
              plan={option}
              monthly={monthlyFor(option.tier)}
              recommended={option.tier === tierFor(highlight)}
              busy={purchase.isPending}
              onPress={() =>
                purchase.mutate(option, {
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

      <TopUp />

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

      <LegalLinks />
    </>
  );
}

/**
 * The privacy policy and the terms, on the screen that sells the subscription.
 *
 * Required, not decorative: Apple's Developer Program Licence Agreement,
 * Schedule 2 §3.8(b) makes both a condition of selling an auto-renewing
 * subscription, and 3.1.2 review rejects paywalls that omit them. They existed
 * in Settings → About, which is where the developer sees them every day and the
 * buyer never does.
 *
 * Rendered as text buttons rather than a card: they are a legal footer, and
 * anything with a border here would compete with the plan cards above.
 */
function LegalLinks() {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const privacy = privacyPolicyUrl();
  const terms = termsUrl();

  const open = (url: string | null, what: string) => {
    if (!url) {
      // Said rather than silently ignored. A row that opens nothing is the
      // failure this replaces.
      toast.show({ message: `No ${what} is set up yet.`, tone: 'warning' });
      return;
    }
    void Linking.openURL(url).catch(() =>
      toast.show({ message: `Could not open the ${what}.`, tone: 'danger' }),
    );
  };

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.lg }}>
      <Pressable
        testID="plans-privacy"
        accessibilityRole="link"
        accessibilityLabel="Privacy policy"
        onPress={() => open(privacy, 'privacy policy')}
        hitSlop={10}
      >
        <Txt variant="caption" style={{ color: colors.accent }}>
          Privacy policy
        </Txt>
      </Pressable>
      <Pressable
        testID="plans-terms"
        accessibilityRole="link"
        accessibilityLabel="Terms of use"
        onPress={() => open(terms, 'terms of use')}
        hitSlop={10}
      >
        <Txt variant="caption" style={{ color: colors.accent }}>
          Terms of use
        </Txt>
      </Pressable>
    </View>
  );
}
