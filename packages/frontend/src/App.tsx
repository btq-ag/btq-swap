import { createBrowserRouter, Outlet, Navigate, useLocation } from 'react-router-dom';
import { Header } from './components/layout/Header';
import { Footer } from './components/layout/Footer';
import { AdminSidebar } from './components/layout/AdminSidebar';
import { ErrorBoundary, RouteErrorFallback } from './components/common/ErrorBoundary';
import { TradePage } from './pages/TradePage';
import { HistoryPage } from './pages/HistoryPage';
import { SwapDetailPage } from './pages/SwapDetailPage';
import { DashboardPage } from './pages/admin/DashboardPage';
import { SwapsPage } from './pages/admin/SwapsPage';
import { UsersPage } from './pages/admin/UsersPage';
import { ConfigPage } from './pages/admin/ConfigPage';
import { WalletPage } from './pages/admin/WalletPage';
import { SystemPage } from './pages/admin/SystemPage';
import { useAuthStore } from './store/authStore';

function MainLayout() {
  const location = useLocation();
  const isTradePage = location.pathname === '/';

  return (
    <div className="flex min-h-screen flex-col bg-slate-950">
      <Header />
      <main className="flex-1">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
      {!isTradePage && <Footer />}
    </div>
  );
}

function AdminLayout() {
  const { isAdmin, isAuthenticated } = useAuthStore();

  if (!isAuthenticated || !isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex h-screen bg-slate-950">
      <AdminSidebar />
      <main className="flex-1 overflow-y-auto">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <MainLayout />,
    errorElement: <RouteErrorFallback />,
    children: [
      { index: true, element: <TradePage />, errorElement: <RouteErrorFallback /> },
      { path: 'history', element: <HistoryPage />, errorElement: <RouteErrorFallback /> },
      { path: 'swaps/:id', element: <SwapDetailPage />, errorElement: <RouteErrorFallback /> },
    ],
  },
  {
    path: 'admin',
    element: <AdminLayout />,
    errorElement: <RouteErrorFallback />,
    children: [
      { index: true, element: <DashboardPage />, errorElement: <RouteErrorFallback /> },
      { path: 'swaps', element: <SwapsPage />, errorElement: <RouteErrorFallback /> },
      { path: 'users', element: <UsersPage />, errorElement: <RouteErrorFallback /> },
      { path: 'config', element: <ConfigPage />, errorElement: <RouteErrorFallback /> },
      { path: 'wallet', element: <WalletPage />, errorElement: <RouteErrorFallback /> },
      { path: 'system', element: <SystemPage />, errorElement: <RouteErrorFallback /> },
    ],
  },
]);
