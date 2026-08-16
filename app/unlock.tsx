/**
 * Where a web purchase comes home.
 *
 * Stripe Checkout runs on a web page, and its `success_url` sends the browser
 * to `ridik:///unlock?session=…`. That is a deep link, and this app has exactly
 * one way of handling those: a file route. expo-router matches the URL, hands
 * over the query, and this screen does the one thing that has to happen —
 * gives the session to the backend, waits for a verdict, says what it was, and
 * gets out of the way.
 *
 * It is a route rather than a `Linking` listener in the root layout, and that
 * was learned the hard way. A listener has to answer for a URL the router has
 * already failed to match, so it lands on "Unmatched Route" first and has to
 * navigate off it — which on a cold start means the launch screen is an error
 * page for as long as the app takes to boot, and which tears the layout subtree
 * down and remounts it. The toast raised by the redemption then went into a
 * `ToastProvider` that was already being discarded, and a rejected link
 * announced itself to nobody. A real route has none of that: nothing is ever
 * unmatched, and this component is alive for the whole exchange.
 *
 * All the judgement lives in `src/services/billing/webFunnel.ts`. This decides
 * nothing about who has paid; it is the screen that shows the answer.
 */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { invalidateKeys, qk } from '@/hooks/keys';
import { redeemUnlockLink } from '@/services/billing/webFunnel';
import { Spinner, Txt, useToast } from '@/ui/components';
import { useTheme } from '@/ui/ThemeProvider';

/**
 * The parameter names `webFunnel` accepts, in its own preference order.
 *
 * The link is rebuilt rather than read field by field so that one parser owns
 * what a valid session looks like. Anything this screen decided for itself
 * would be a second, quieter set of rules for the same string.
 */
const SESSION_PARAMS = ['session', 'session_id', 'token'] as const;

function linkFrom(params: Record<string, string | string[] | undefined>): string {
  const query = SESSION_PARAMS.flatMap((name) => {
    const raw = params[name];
    // A repeated parameter arrives as an array. Keep every value: two different
    // ones is exactly the case the parser has to be able to refuse.
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    return values.map((value) => `${name}=${encodeURIComponent(value)}`);
  }).join('&');
  return `ridik:///unlock${query ? `?${query}` : ''}`;
}

export default function UnlockScreen() {
  const router = useRouter();
  const toast = useToast();
  const client = useQueryClient();
  const { colors } = useTheme();
  const params = useLocalSearchParams();
  const [message, setMessage] = useState('Confirming your purchase…');
  // A remount would redeem a second time; the funnel would answer from memory,
  // but the user would be told twice about one payment.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void redeemUnlockLink(linkFrom(params)).then(async (outcome) => {
      if (outcome.status === 'unlocked') {
        // The entitlement changed underneath every cached read of it.
        await invalidateKeys(client, [qk.billing.all]);
        toast.show({ message: 'Subscription unlocked', tone: 'success' });
      } else if (outcome.status === 'pending') {
        toast.show({ message: outcome.message, tone: 'neutral', durationMs: 6000 });
      } else if (outcome.status === 'rejected') {
        // Said out loud, always. A link that fails quietly is indistinguishable
        // from an app that took the money and ignored it.
        toast.show({ message: outcome.message, tone: 'danger', durationMs: 6000 });
      }
      // `unconfigured` and `ignored` say nothing: a build with no backend has to
      // behave exactly as it did before any of this existed.

      setMessage('');
      // Home, always. There is nothing to stay here for, and leaving the user
      // on a screen with no content and no way back would be worse than the
      // error page this route exists to avoid.
      router.replace('/');
    });
    // Once, on mount. `params` is a fresh object every render and the redemption
    // must not restart because something above us re-rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={[styles.centre, { backgroundColor: colors.bg }]}>
      {message ? (
        <>
          <Spinner size="large" color={colors.accent} accessibilityLabel="Confirming your purchase" />
          <Txt variant="caption" tone="secondary">
            {message}
          </Txt>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
});
