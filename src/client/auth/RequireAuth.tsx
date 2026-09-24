import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './auth-context';

export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="page-loading" role="status">
        Loading…
      </div>
    );
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
