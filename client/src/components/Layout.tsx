import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Cake, CalendarClock, FileSpreadsheet, LogOut, Menu, MessageCircle, Radio, ScrollText, Sparkles, X } from 'lucide-react';
import { useAuth } from '../lib/auth';

const NAV = [
  { to: '/live', label: 'Live Report', icon: Radio, live: true, hint: 'Fetch · report · send' },
  { to: '/schedule', label: 'Auto Send', icon: CalendarClock, hint: 'Daily automatic report' },
  { to: '/whatsapp', label: 'WhatsApp Setup', icon: MessageCircle, hint: 'Connect & choose groups' },
  { to: '/motivation', label: 'Team Messages', icon: Sparkles, hint: 'Schedule a custom message' },
  { to: '/employees', label: 'Employees', icon: Cake, hint: 'Profiles & birthday messages' },
  { to: '/logs', label: 'Delivery Logs', icon: ScrollText, hint: 'What was sent' },
];

export function Layout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = (
    <nav className="flex flex-col gap-1 p-3">
      {NAV.map(({ to, label, icon: Icon, live, hint }) => (
        <NavLink
          key={to}
          to={to}
          onClick={() => setOpen(false)}
          className={({ isActive }) => `flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium transition ${isActive ? 'border-accent/30 bg-accent/15 text-ink' : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}
        >
          <Icon className="h-4.5 w-4.5 shrink-0" />
          <span className="min-w-0"><span className="block">{label}</span><span className="block text-[11px] font-normal text-slate-500">{hint}</span></span>
          {live && <span className="ml-auto rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-emerald-400">LIVE</span>}
        </NavLink>
      ))}
    </nav>
  );
  const brand = (
    <div className="flex items-center gap-3 px-5 py-5">
      <div className="grid h-9 w-9 place-items-center rounded-lg bg-accent shadow-[0_6px_20px_-6px_var(--color-accent)]"><FileSpreadsheet className="h-5 w-5 text-white" /></div>
      <div>
        <div className="text-sm font-bold leading-tight text-ink">Tata Dialer</div>
        <div className="text-xs text-slate-500">CDR Report Automation</div>
      </div>
    </div>
  );
  const userBox = (
    <div className="border-t border-slate-200 p-4">
      <div className="truncate text-sm font-medium text-ink">{user?.name}</div>
      <div className="mb-3 truncate text-xs text-slate-500">{user?.email} · {user?.role}</div>
      <button onClick={logout} className="flex items-center gap-2 text-xs text-slate-500 hover:text-ink"><LogOut className="h-3.5 w-3.5" /> Sign out</button>
    </div>
  );

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-slate-200 bg-surface lg:flex">
        {brand}
        <div className="flex-1 overflow-y-auto">{nav}</div>
        {userBox}
      </aside>
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-surface/90 px-4 py-3 backdrop-blur lg:hidden">
        <div className="text-sm font-bold text-ink">Tata Dialer · CDR Reports</div>
        <button aria-label="Open menu" onClick={() => setOpen(true)} className="text-ink"><Menu /></button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="fade-in absolute inset-y-0 left-0 flex w-72 flex-col border-r border-slate-200 bg-surface">
            <button aria-label="Close menu" onClick={() => setOpen(false)} className="absolute right-3 top-4 text-slate-500"><X /></button>
            {brand}
            <div className="flex-1 overflow-y-auto">{nav}</div>
            {userBox}
          </aside>
        </div>
      )}
      <main className="px-4 py-6 sm:px-6 lg:ml-64 lg:px-8 lg:py-8">
        <div className="mx-auto max-w-7xl"><Outlet /></div>
      </main>
    </div>
  );
}
