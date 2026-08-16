/**
 * The disclosure as a place you can go back to.
 *
 * `ConsentGate` shows the same component over the navigator on a first run, and
 * that would be enough to *collect* the decision — but a permission you cannot
 * find again is not a permission, it is a trapdoor. This route is where
 * Settings sends someone who wants to change their mind, and where every
 * "Ridik answered on its own" notice in the voice dock points, so the sentence
 * that explains the assistant is off is one tap from the screen that turns it
 * back on.
 *
 * Changing the answer always goes through the whole disclosure rather than a
 * switch. A toggle that turns consent back on without showing what is being
 * consented to is not consent, and a toggle that turns it off is the only half
 * of that pair anyone would be tempted to build.
 */
import { useRouter } from 'expo-router';

import { ConsentScreen } from '@/features/consent';

export default function ConsentRoute() {
  const router = useRouter();

  return (
    <ConsentScreen
      // Asked when pressed, not while rendering: this is reachable from a
      // notice in a dock that may have been opened over an empty stack, and
      // home is where every route leads anyway.
      onDone={() => (router.canGoBack() ? router.back() : router.replace('/'))}
    />
  );
}
