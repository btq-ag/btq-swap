import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, NavLink, Outlet, RouterProvider } from 'react-router-dom';
import { AdminPage } from './pages/Admin';
import { MonitorPage } from './pages/Monitor';
import { SwapPage } from './pages/SwapPage';
import { TradeDesk } from './pages/TradeDesk';
import './index.css';

function Shell() {
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-control px-3 py-1.5 text-[13px] font-medium ${isActive ? 'bg-white/10 text-fog' : 'text-fog-3 hover:text-fog'}`;
  return (
    <div className="min-h-screen bg-ink text-fog">
      <header className="flex h-12 items-center justify-between border-b border-white/10 px-4">
        <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight text-fog">
          <img src="/btq-mark.svg" alt="" width="22" height="22" />
          BTQ Swap
        </NavLink>
        <nav className="flex items-center gap-1" aria-label="Sections">
          <NavLink to="/" end className={link}>Trade</NavLink>
          <NavLink to="/monitor" className={link}>Monitor</NavLink>
          <NavLink to="/admin" className={link}>Operator</NavLink>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { index: true, element: <TradeDesk /> },
      { path: 'monitor', element: <MonitorPage /> },
      { path: 'swap/:id', element: <SwapPage /> },
      { path: 'admin', element: <AdminPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
