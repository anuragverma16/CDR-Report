import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import Login from './pages/Login';

// Each page is its own download, fetched when first opened: the first screen only loads the login page and layout
const LiveReport = lazy(() => import('./pages/LiveReport'));
const ReportDetail = lazy(() => import('./pages/ReportDetail'));
const WhatsApp = lazy(() => import('./pages/WhatsApp'));
const ScheduleSettings = lazy(() => import('./pages/Schedule'));
const Motivation = lazy(() => import('./pages/Motivation'));
const DeliveryLogs = lazy(() => import('./pages/DeliveryLogs'));
const Employees = lazy(() => import('./pages/Employees'));
const Payments = lazy(() => import('./pages/Payments'));

const PageLoading = () => <div className="grid min-h-[40vh] place-items-center"><Spinner label="Loading…" /></div>;

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid min-h-screen place-items-center"><Spinner label="Loading…" /></div>;
  if (!user) return <Login />;
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/live" replace />} />
          <Route path="live" element={<LiveReport />} />
          <Route path="reports/:id" element={<ReportDetail />} />
          <Route path="whatsapp" element={<WhatsApp />} />
          <Route path="schedule" element={<ScheduleSettings />} />
          <Route path="motivation" element={<Motivation />} />
          <Route path="employees" element={<Employees />} />
          <Route path="payments" element={<Payments />} />
          <Route path="logs" element={<DeliveryLogs />} />
          <Route path="*" element={<Navigate to="/live" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
