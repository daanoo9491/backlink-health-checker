import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="empty">
      <p className="empty-title">This page doesn’t exist</p>
      <p>The address may be mistyped, or the page may have moved.</p>
      <Link to="/" className="button button-secondary">
        Go to the dashboard
      </Link>
    </div>
  );
}
