import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { Icon, type IconName } from './Icon';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/scans/new', label: 'New scan', icon: 'upload' },
  { to: '/scans', label: 'Scan history', icon: 'history', end: true },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/scans/new': 'New scan',
  '/scans': 'Scan history',
  '/settings': 'Settings',
};

export function AppLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const menuOpen = openFor === pathname; // closes itself when the route changes
  const title = TITLES[pathname] ?? 'Page not found';

  useEffect(() => {
    document.title = `${title} · Backlink Health Checker`;
  }, [title]);

  async function handleSignOut() {
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <aside className={`sidebar${menuOpen ? ' is-open' : ''}`} aria-label="Main">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="link" size={20} />
          </span>
          <span className="brand-name">Backlink Health Checker</span>
        </div>
        <nav aria-label="Main navigation">
          <ul className="nav-list">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className="nav-link">
                  <Icon name={item.icon} />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <button type="button" className="nav-link nav-signout" onClick={handleSignOut}>
          <Icon name="logout" />
          Sign out
        </button>
      </aside>
      {menuOpen && <div className="scrim" onClick={() => setOpenFor(null)} aria-hidden="true" />}

      <div className="main-col">
        <header className="topbar">
          <button
            type="button"
            className="icon-button menu-button"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            onClick={() => setOpenFor(menuOpen ? null : pathname)}
          >
            <Icon name={menuOpen ? 'close' : 'menu'} size={22} />
          </button>
          <h1 className="page-title">{title}</h1>
          <div className="user-chip" title={user?.email}>
            <span className="avatar" aria-hidden="true">
              {user?.email.charAt(0).toUpperCase()}
            </span>
            <span className="user-email">{user?.email}</span>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
