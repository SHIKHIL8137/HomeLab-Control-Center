import { Lock } from 'lucide-react';
import { EmptyState, PageHeader } from '../components/ui';

/** Honest placeholder: the section exists in the navigation but its backend is not built yet. */
export default function Planned({
  title,
  phase,
  children,
}: {
  title: string;
  phase: number;
  children: string;
}) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        icon={<Lock className="h-6 w-6 text-muted" aria-hidden />}
        title={`Not available yet (planned for Phase ${phase})`}
      >
        {children}
      </EmptyState>
    </>
  );
}
