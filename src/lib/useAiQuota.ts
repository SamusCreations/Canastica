import { useSyncExternalStore } from 'react';
import { getAiQuota, subscribeAiQuota, type AiQuota } from '../services/geminiAndSupabaseService';

/** Today's AI quota for the signed-in account (null until the server reports it). */
export function useAiQuota(): AiQuota | null {
  return useSyncExternalStore(subscribeAiQuota, getAiQuota);
}
