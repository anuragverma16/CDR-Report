import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import Login from './pages/Login';
import ReportDetail from './pages/ReportDetail';
import WhatsApp from './pages/WhatsApp';
import ScheduleSettings from './pages/Schedule';
import Motivation from './pages/Motivation';
import DeliveryLogs from './pages/DeliveryLogs';
import LiveReport from './pages/LiveReport';
import Employees from './pages/Employees';

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid min-h-screen place-items-center"><Spinner label="Loading…" /></div>;
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/live" replace />} />
        <Route path="live" element={<LiveReport />} />
        <Route path="reports/:id" element={<ReportDetail />} />
        <Route path="whatsapp" element={<WhatsApp />} />
        <Route path="schedule" element={<ScheduleSettings />} />
        <Route path="motivation" element={<Motivation />} />
        <Route path="employees" element={<Employees />} />
        <Route path="logs" element={<DeliveryLogs />} />
        <Route path="*" element={<Navigate to="/live" replace />} />
      </Route>
    </Routes>
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
