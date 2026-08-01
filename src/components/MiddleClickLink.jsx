import { useNavigate } from 'react-router-dom'

// A click target that behaves like a real link (middle-click / Ctrl+click / Cmd+click opens a
// new tab, right-click offers "Open in new tab", hover shows the URL) while still using the
// router's client-side navigate() for an ordinary left click, so in-app navigation keeps whatever
// perf-optimizing router state (`state`) the caller wants to pass along. Swap in for any
// `<button onClick={() => navigate(...)}>` that points at an internal route.
export default function MiddleClickLink({ to, state, children, style, className, draggable, stopPropagation, onClick, ...rest }) {
  const navigate = useNavigate()
  if (!to) return children

  return (
    <a
      href={to}
      draggable={draggable}
      className={className}
      style={style}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation()
        onClick?.(e)
        if (e.defaultPrevented) return
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(to, state ? { state } : undefined)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}
