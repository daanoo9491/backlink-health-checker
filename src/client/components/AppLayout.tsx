import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { BRAND, TOOLS } from '../../shared/brand';
import { useAuth } from '../auth/auth-context';
import { Icon, type IconName } from './Icon';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  soon?: boolean;
}

/** The menu: shared pages, then one section per tool. */
const NAV: { section?: string; items: NavItem[] }[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: 'dashboard', end: true }] },
  {
    section: TOOLS.linkHealth,
    items: [
      { to: '/scans/new', label: 'New scan', icon: 'upload' },
      { to: '/scans', label: 'Scan history', icon: 'history', end: true },
    ],
  },
  {
    section: TOOLS.indexChecker,
    items: [
      { to: '/index-checker/new', label: 'New index check', icon: 'search' },
      { to: '/index-checker', label: 'Index checks', icon: 'history', end: true },
    ],
  },
  { items: [{ to: '/settings', label: 'Settings', icon: 'settings' }] },
];

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/scans/new': 'New scan',
  '/scans': 'Scan history',
  '/index-checker': TOOLS.indexChecker,
  '/index-checker/new': 'New index check',
  '/settings': 'Settings',
};

export function AppLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const menuOpen = openFor === pathname; // closes itself when the route changes
  const title = TITLES[pathname] ?? (/^\/scans\/[^/]+$/.test(pathname) ? 'Scan' : 'Page not found');

  useEffect(() => {
    document.title = `${title} · ${BRAND.name}`;
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
          <span className="brand-text">
            <span className="brand-name">{BRAND.name}</span>
            <span className="brand-tagline">{BRAND.tagline}</span>
          </span>
        </div>
        <nav aria-label="Main navigation" className="nav">
          {NAV.map((group, i) => (
            <div key={group.section ?? i} className="nav-group">
              {group.section && (
                <p className="nav-section" id={`nav-${i}`}>
                  {group.section}
                </p>
              )}
              <ul className="nav-list" aria-labelledby={group.section ? `nav-${i}` : undefined}>
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.end} className="nav-link">
                      <Icon name={item.icon} />
                      {item.label}
                      {item.soon && <span className="nav-soon">Soon</span>}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
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
