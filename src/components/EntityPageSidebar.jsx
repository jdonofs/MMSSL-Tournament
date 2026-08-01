import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import useIsCompactViewport from '../hooks/useIsCompactViewport'

// BR-style sticky left sidebar for Character/Team pages: a list of real route links (Career +
// one per season/tournament) plus jump-links to sections within whichever scope page is open.
// Below 900px this collapses to a scope <select> (routes grow every season, so a dropdown scales
// better than a pill row) plus a horizontally-scrollable pill strip for the fixed-size section list.
export default function EntityPageSidebar({ title, scopeLinks = [], sectionLinks = [] }) {
  const isCompact = useIsCompactViewport(900)
  const location = useLocation()
  const navigate = useNavigate()

  if (isCompact) {
    const activeScope = scopeLinks.find((link) => link.to === location.pathname)

    return (
      <nav className="entity-sidebar entity-sidebar-compact">
        {scopeLinks.length > 1 && (
          <select
            className="entity-sidebar-scope-select"
            value={activeScope ? activeScope.to : scopeLinks[0]?.to}
            onChange={(event) => navigate(event.target.value)}
          >
            {scopeLinks.map((link) => (
              <option key={link.to} value={link.to}>{link.label}</option>
            ))}
          </select>
        )}

        {sectionLinks.length > 0 && (
          <div className="entity-sidebar-sections">
            {sectionLinks.map((item) => (
              <button
                key={item.id}
                type="button"
                className="entity-sidebar-section-pill"
                onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </nav>
    )
  }

  return (
    <nav className="entity-sidebar">
      {title && (
        <div className="entity-sidebar-title">
          {title}
        </div>
      )}

      {scopeLinks.length > 0 && (
        <div className="entity-sidebar-scopes">
          {scopeLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end
              className={({ isActive }) => `entity-sidebar-scope-link ${isActive ? 'entity-sidebar-scope-link-active' : ''}`}
            >
              <span>{link.label}</span>
              {link.badge && <span className="entity-sidebar-scope-badge">{link.badge}</span>}
            </NavLink>
          ))}
        </div>
      )}

      {sectionLinks.length > 0 && (
        <div className={`entity-sidebar-section-list ${scopeLinks.length ? 'entity-sidebar-section-list-divided' : ''}`}>
          {sectionLinks.map((item) => (
            <button
              key={item.id}
              type="button"
              className="entity-sidebar-section-link"
              onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </nav>
  )
}
