import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import { useAuthStatus } from './hooks';
import { Layout } from './components/Layout';
import { Notice, Spinner } from './components/ui';
import { AuthPage } from './pages/AuthPage';
import Audit from './pages/Audit';
import Containers from './pages/Containers';
import Overview from './pages/Overview';
import Planned from './pages/Planned';
import ProjectDetail from './pages/ProjectDetail';
import Projects from './pages/Projects';
import Settings from './pages/Settings';

// Charts are the heaviest dependency, so load them only when the page is opened.
const Monitoring = lazy(() => import('./pages/Monitoring'));

export default function App() {
  const auth = useAuthStatus();
  if (auth.isLoading) return <Spinner label="Starting" />;
  if (auth.error || !auth.data) {
    return (
      <div className="mx-auto max-w-md p-6">
        <Notice tone="bad" title="Cannot reach the API">
          Check that the server is running, then reload.
        </Notice>
      </div>
    );
  }
  if (auth.data.setupRequired) return <AuthPage mode="setup" />;
  if (!auth.data.authenticated) return <AuthPage mode="login" />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
        <Route path="containers" element={<Containers />} />
        <Route
          path="monitoring"
          element={
            <Suspense fallback={<Spinner />}>
              <Monitoring />
            </Suspense>
          }
        />
        <Route path="audit" element={<Audit />} />
        <Route path="settings" element={<Settings />} />
        <Route
          path="deployments"
          element={
            <Planned title="Deployments" phase={5}>
              Deployment history and GitHub workflow status are read-only first; controlled
              deployment comes later and needs your explicit approval.
            </Planned>
          }
        />
        <Route
          path="logs"
          element={
            <Planned title="Logs" phase={4}>
              A bounded, redacted log viewer for an explicit allowlist of sources.
            </Planned>
          }
        />
        <Route
          path="alerts"
          element={
            <Planned title="Alerts & Incidents" phase={4}>
              Threshold rules with cooldowns, acknowledgement and resolution.
            </Planned>
          }
        />
        <Route
          path="environment"
          element={
            <Planned title="Environment Configuration" phase={7}>
              Masked, encrypted variables with explicit apply steps. No existing secret file is read
              until you approve the scope.
            </Planned>
          }
        />
        <Route
          path="*"
          element={
            <Planned title="Page not found" phase={0}>
              That page does not exist.
            </Planned>
          }
        />
      </Route>
    </Routes>
  );
}
