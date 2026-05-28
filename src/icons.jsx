/* Icons — inline SVG, sized 1em by default. */

const Icon = ({ name, size = 14, stroke = 1.6, ...rest }) => {
  const s = size;
  const sw = stroke;
  const common = {
    width: s, height: s, viewBox: "0 0 24 24",
    fill: "none", stroke: "currentColor",
    strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round",
    ...rest,
  };
  switch (name) {
    case "chev-right":
      return <svg {...common}><path d="M9 6l6 6-6 6" /></svg>;
    case "chev-down":
      return <svg {...common}><path d="M6 9l6 6 6-6" /></svg>;
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>;
    case "x":
      return <svg {...common}><path d="M6 6l12 12M6 18L18 6" /></svg>;
    case "lock":
      return <svg {...common}><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 1 1 8 0v3" /></svg>;
    case "lock-open":
      return <svg {...common}><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></svg>;
    case "plus":
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case "min":
      return <svg {...common}><path d="M5 12h14" /></svg>;
    case "max":
      return <svg {...common}><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg>;
    case "split":
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M12 4v16" /></svg>;
    case "refresh":
      return <svg {...common}><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v6h-6" /></svg>;
    case "cluster":
      return <svg {...common}>
        <path d="M12 3l9 5-9 5-9-5 9-5z" />
        <path d="M3 13l9 5 9-5" />
        <path d="M3 17l9 5 9-5" />
      </svg>;
    case "ns":
      return <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18" />
      </svg>;
    case "db":
      return <svg {...common}>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
        <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
      </svg>;
    case "user":
      return <svg {...common}>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4.4 3.58-8 8-8s8 3.6 8 8" />
      </svg>;
    case "key":
      return <svg {...common}>
        <circle cx="7.5" cy="15.5" r="3.5" />
        <path d="M10 13l8-8M16 7l3 3M14 9l3 3" />
      </svg>;
    case "config":
      return <svg {...common}>
        <path d="M4 6h16M4 12h16M4 18h16" />
        <circle cx="9" cy="6" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="15" cy="12" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="7" cy="18" r="1.5" fill="currentColor" stroke="none" />
      </svg>;
    case "play":
      return <svg {...common}><path d="M7 5l12 7-12 7V5z" fill="currentColor" /></svg>;
    case "stop":
      return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" /></svg>;
    case "table":
      return <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="1.5" />
        <path d="M3 10h18M3 16h18M9 4v16M15 4v16" />
      </svg>;
    case "view":
      return <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="1.5" />
        <path d="M3 10h18M9 4v16" />
        <circle cx="15" cy="15" r="1.4" fill="currentColor" stroke="none" />
      </svg>;
    case "fn":
      return <svg {...common}>
        <path d="M7 20c1.5-4 1.5-8 0-12M11 20c2-4 2-8 0-12M3 8h6M3 16h8" />
      </svg>;
    case "terminal":
      return <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9l3 3-3 3M13 15h4" />
      </svg>;
    case "history":
      return <svg {...common}>
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5" />
        <path d="M12 8v5l3 2" />
      </svg>;
    case "save":
      return <svg {...common}>
        <path d="M5 4h11l3 3v13H5z" />
        <path d="M8 4v4h8V4M8 20v-6h8v6" />
      </svg>;
    case "logo":
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M12 4l8 4v8l-8 4-8-4V8l8-4z" stroke="currentColor" strokeWidth="1.6" />
        <ellipse cx="12" cy="11" rx="4" ry="1.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 11v3c0 .9 1.8 1.6 4 1.6s4-.7 4-1.6v-3" stroke="currentColor" strokeWidth="1.4" />
      </svg>;
    case "sidebar":
      return <svg {...common}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </svg>;
    case "settings":
      return <svg {...common}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 0 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 7.08 4.06l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
      </svg>;
    case "bolt":
      return <svg {...common}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" stroke="none" /></svg>;
    case "dot":
      return <svg {...common}><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></svg>;
    case "tab":
      return <svg {...common}>
        <path d="M3 7h6l2 3h10v9H3z" />
      </svg>;
    default:
      return null;
  }
};

window.Icon = Icon;
