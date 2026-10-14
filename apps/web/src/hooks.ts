import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuditEvent,
  AuthStatus,
  ContainersResponse,
  MetricsHistory,
  Overview,
  ProjectView,
} from '@hlcc/shared';
import { api, setCsrfToken } from './lib/api';

export const POLL_MS = 15_000;
const poll = { refetchInterval: POLL_MS, refetchIntervalInBackground: false };

export const useAuthStatus = () =>
  useQuery({
    queryKey: ['auth'],
    queryFn: async () => {
      const s = await api<AuthStatus>('/auth/status');
      setCsrfToken(s.csrfToken);
      return s;
    },
    staleTime: 30_000,
  });

export const useOverview = () =>
  useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/overview'), ...poll });

export const useContainers = () =>
  useQuery({
    queryKey: ['containers'],
    queryFn: () => api<ContainersResponse>('/containers'),
    ...poll,
  });

export const useProjects = () =>
  useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ items: ProjectView[] }>('/projects'),
    ...poll,
  });

export const useProject = (id: string) =>
  useQuery({
    queryKey: ['project', id],
    queryFn: () => api<ProjectView>(`/projects/${id}`),
    ...poll,
  });

export const useHistory = (minutes: number) =>
  useQuery({
    queryKey: ['history', minutes],
    queryFn: () => api<MetricsHistory>(`/metrics/history?minutes=${minutes}&limit=300`),
    ...poll,
  });

export const useAudit = () =>
  useInfiniteQuery({
    queryKey: ['audit'],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api<{ items: AuditEvent[]; nextBefore: number | null }>(
        `/audit?limit=50${pageParam ? `&before=${pageParam}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });

/** Re-renders on an interval so "updated 12s ago" labels keep moving. */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Server-Sent Events only signal "something changed"; data still comes through the normal API. */
export function useLiveUpdates(): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/v1/stream');
    es.addEventListener('ready', () => setConnected(true));
    es.addEventListener('update', () => {
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] !== 'auth' && q.queryKey[0] !== 'audit',
      });
    });
    es.onerror = () => setConnected(false); // the browser reconnects on its own
    return () => es.close();
  }, [qc]);
  return connected;
}
