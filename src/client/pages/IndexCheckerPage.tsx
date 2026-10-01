import { Link } from 'react-router';
import { TOOLS } from '../../shared/brand';

/**
 * Placeholder for the second tool. The checks themselves arrive in Phases 8–10;
 * this page says plainly what is coming and how results will be judged.
 */
export function IndexCheckerPage() {
  return (
    <div className="stack-lg">
      <section className="panel tool-intro" aria-labelledby="ic-heading">
        <p className="eyebrow">Coming next</p>
        <h2 id="ic-heading" className="section-title">
          {TOOLS.indexChecker}: is each page in Google, or able to be?
        </h2>
        <p>
          Paste or upload URLs, or run it on a {TOOLS.linkHealth} scan. Every URL is checked one of two ways, chosen
          automatically:
        </p>
        <ul className="plain-list">
          <li>
            <strong>Your own sites</strong> (verified in Google Search Console): Google’s own answer, so results can say{' '}
            <em>Indexed</em> or <em>Not indexed</em>, with Google’s reason.
          </li>
          <li>
            <strong>Other people’s sites</strong>: the signals any crawler can read (robots.txt, noindex tags and
            headers, canonical, whether the page loads). These show whether a page <em>can</em> be indexed.
          </li>
        </ul>
        <p className="notice notice-info">
          We never label someone else’s page “Not indexed”: only Google Search Console can confirm that. A check that
          fails shows as “Unknown”, never as a negative.
        </p>
      </section>

      <section aria-labelledby="ic-plan">
        <h2 id="ic-plan" className="section-title">
          When it arrives
        </h2>
        <ol className="plain-list">
          <li>Indexability signals for any URL (robots.txt, noindex, canonical).</li>
          <li>Google Search Console for your verified sites, such as lanop.co.uk.</li>
          <li>Optional: an exact-URL Google lookup through a paid search-data provider, off by default.</li>
        </ol>
        <p className="form-hint ic-note">
          Before step 2 we’ll need the Search Console sites to connect and an owner to add one service-account email to
          each of them.
        </p>
      </section>

      <p>
        <Link to="/scans/new" className="button button-secondary">
          Go to {TOOLS.linkHealth}
        </Link>
      </p>
    </div>
  );
}
