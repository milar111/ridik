/**
 * Telling the user their words go to a third party, before they do.
 *
 * The barrel carries the screens. Anything on the money path — the pipeline's
 * gate, the settings patch a decision writes — imports `./gate` directly, which
 * is free of React and of every native module so the `logic` test project can
 * load it under plain Node.
 */
export { ConsentGate } from './ConsentGate';
export { ConsentScreen } from './ConsentScreen';
export type { ConsentScreenProps } from './ConsentScreen';
export {
  assistantMayReachProvider,
  consentPatch,
  readAssistantConsent,
} from './gate';
