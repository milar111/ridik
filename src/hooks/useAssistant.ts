import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { assistantMode, type AssistantMode } from '@/features/voice/mode';
import { qk } from './keys';

/**
 * Which way this build reaches the assistant: through your backend, through a
 * key on this device, or not at all.
 *
 * Settings uses it to decide whether a key field is even meaningful — in a
 * store build there is nothing for the user to paste, and offering the field
 * would be an invitation to break something they cannot fix.
 */
export function useAssistantMode(): UseQueryResult<AssistantMode> {
  return useQuery({
    queryKey: qk.assistant.mode(),
    queryFn: () => assistantMode(),
    staleTime: 30_000,
  });
}

export type { AssistantMode };
