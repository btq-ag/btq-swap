import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, NavLink, Outlet, RouterProvider } from 'react-router-dom';
import { AdminPage } from './pages/Admin';
import { MonitorPage } from './pages/Monitor';
import { SwapPage } from './pages/SwapPage';
import './index.css';

function Shell() {
  const link = ({ isActive }: { isActive: boolean }) => `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-ink-3 text-fog' : 'text-fog-3 hover:text-fog-2'}`;
  return (
    <div className="min-h-screen">
      <nav className="border-b border-ink-line bg-ink/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-3">
          <NavLink to="/" className="flex items-center gap-2.5 font-semibold text-fog">
            <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
              <path d="M5 10h22M5 22h22" stroke="#38BDF8" strokeWidth="3" strokeLinecap="round" />
              <path d="M5 22h22" stroke="#A78BFA" strokeWidth="3" strokeLinecap="round" />
              <circle cx="16" cy="16" r="4" fill="#F5C451" />
            </svg>
            BTQ Swap
          </NavLink>
          <div className="flex items-center gap-1">
            <NavLink to="/" end className={link}>Monitor</NavLink>
            <NavLink to="/admin" className={link}>Operator</NavLink>
            <a href="/downloads/btq-htlc.mjs" className="rounded-md px-3 py-1.5 text-sm text-fog-3 hover:text-fog-2">btq-htlc tool</a>
          </div>
        </div>
      </nav>
      <Outlet />
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { index: true, element: <MonitorPage /> },
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
