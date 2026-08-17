/**
 * Where Google's browser comes home, and nothing else.
 *
 * `redirectUriFor()` sends `ai.dby.ridik:/oauthredirect`. That URL arrives
 * as a deep link, and `expo-auth-session` is already listening for it — it
 * dismisses the browser and resolves `promptAsync` with the code. This screen
 * has no part in that and deliberately reads nothing from the query: the code
 * is single-use and PKCE binds it to the verifier held by the request object,
 * so a second reader here could only take it away from the flow that can spend
 * it.
 *
 * It exists because the deep link reaches the router too. Without a file to
 * match, expo-router draws "Unmatched Route" — so the sign-in would succeed,
 * the account would connect, and the user would be looking at a page-not-found
 * error while it happened. `app/unlock.tsx` records the same lesson from the
 * Stripe side: a real route beats a listener answering for a URL the router has
 * already failed to match.
 *
 * So it is a route that immediately gets out of the way. Back, because the
 * screen that started the sign-in is directly underneath and is where the
 * result is about to appear; home only when there is no stack to go back to,
 * which means the app was killed while the browser was open.
 */
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '@/ui/ThemeProvider';

export default function OAuthRedirectScreen() {
  const router = useRouter();
  const { colors } = useTheme();

  useEffect(() => {
    // A frame, not a delay: navigating during the first commit races the
    // navigator's own mount and is dropped, which strands the screen it was
    // meant to leave.
    const id = setTimeout(() => {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }, 0);
    return () => clearTimeout(id);
  }, [router]);

  /* The app's own ground rather than nothing: a transparent frame here reads as
     a flash of white on the way back. */
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} />;
}
