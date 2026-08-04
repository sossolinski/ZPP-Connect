import { clsx } from "clsx";
import {
  BookOpenCheck,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileText,
  Gauge,
  HeartHandshake,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  RadioTower,
  Settings,
  ShieldCheck,
  Sun,
  UserCog,
  UsersRound,
  X
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { createContext, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useApp } from "../lib/app-context";
import { useTheme } from "../lib/theme-context";
import type { SessionRecord } from "../lib/types";
import type { DemoUser, PortalRouteKey, StatItem, TableColumn, TimelineItem } from "../lib/portal-types";
import { NotificationCenter } from "./NotificationCenter";

type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "gold" | "petrol" | "navy";
type PageChrome = {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
};
type PageChromeState = PageChrome & {
  path: string;
};
type PageChromeContextValue = {
  setPageChrome: (chrome: PageChrome) => void;
};

const PageChromeContext = createContext<PageChromeContextValue | null>(null);

type NavigationItem = {
  key: PortalRouteKey;
  to: string;
  label: string;
  group: string;
  icon: ComponentType<{ className?: string }>;
};

export const navigationItems: NavigationItem[] = [
  { key: "dashboard", to: "/dashboard", label: "Dashboard", group: "Command", icon: LayoutDashboard },
  { key: "active-event", to: "/active-event", label: "Active Event", group: "Command", icon: RadioTower },
  { key: "sessions", to: "/sessions", label: "Sessions", group: "Command", icon: Gauge },
  { key: "tec-intake", to: "/tec-intake", label: "TEC Intake", group: "Case Work", icon: ClipboardList },
  { key: "family-nok", to: "/family-nok", label: "Family / NOK", group: "Case Work", icon: HeartHandshake },
  { key: "passenger-src", to: "/passenger-src", label: "Passenger / SRC", group: "Case Work", icon: UsersRound },
  { key: "matching", to: "/matching", label: "Matching", group: "Case Work", icon: ShieldCheck },
  { key: "release-control", to: "/release-control", label: "Release Control", group: "Case Work", icon: ShieldCheck },
  { key: "requests", to: "/requests", label: "Requests", group: "Case Work", icon: ClipboardList },
  { key: "timeline", to: "/timeline", label: "Timeline", group: "Case Work", icon: Gauge },
  { key: "members", to: "/members", label: "Members", group: "People", icon: UsersRound },
  { key: "groups", to: "/groups", label: "Groups", group: "People", icon: UsersRound },
  { key: "rostering", to: "/rostering", label: "Rostering", group: "People", icon: CalendarDays },
  { key: "assignments", to: "/assignments", label: "Assignments", group: "People", icon: ClipboardList },
  { key: "training", to: "/training", label: "Training", group: "Readiness", icon: BookOpenCheck },
  { key: "documents", to: "/documents", label: "Documents", group: "Readiness", icon: FileText },
  { key: "readiness", to: "/readiness", label: "Readiness", group: "Readiness", icon: Gauge },
  { key: "exercise", to: "/exercise", label: "Exercise", group: "Readiness", icon: ClipboardList },
  { key: "files-import", to: "/files-import", label: "Files / Import", group: "Admin", icon: FileText },
  { key: "reports", to: "/reports", label: "Reports", group: "Admin", icon: BookOpenCheck },
  { key: "users-access", to: "/users-access", label: "Users & Access", group: "Admin", icon: UserCog },
  { key: "roles-permissions", to: "/roles-permissions", label: "Roles & Permissions", group: "Admin", icon: ShieldCheck },
  { key: "audit", to: "/audit", label: "Audit", group: "Admin", icon: ShieldCheck },
  { key: "settings", to: "/settings", label: "Settings", group: "Account", icon: Settings }
];

const navGroups = ["Command", "Case Work", "People", "Readiness", "Account", "Admin"];
const defaultOpenNavGroups = ["Command"];

function visibleGroupsFor(visibleNav: NavigationItem[]) {
  return navGroups.filter((group) => visibleNav.some((item) => item.group === group));
}

function useExpandedNavGroups(visibleNav: NavigationItem[], activeNav?: NavigationItem) {
  const visibleGroupNames = visibleGroupsFor(visibleNav);
  const visibleGroupKey = visibleGroupNames.join("|");
  const [expandedGroups, setExpandedGroups] = useState<string[]>(() => {
    const initialGroups = [...defaultOpenNavGroups];
    if (activeNav?.group && !initialGroups.includes(activeNav.group)) initialGroups.push(activeNav.group);
    return initialGroups.filter((group) => visibleGroupNames.includes(group));
  });
  const expandedGroupSet = useMemo(() => new Set(expandedGroups), [expandedGroups]);

  useEffect(() => {
    setExpandedGroups((current) => {
      const allowedGroups = new Set(visibleGroupNames);
      const nextGroups = current.filter((group) => allowedGroups.has(group));

      if (activeNav?.group && allowedGroups.has(activeNav.group) && !nextGroups.includes(activeNav.group)) {
        nextGroups.push(activeNav.group);
      }

      if (!nextGroups.length && visibleGroupNames[0]) {
        nextGroups.push(visibleGroupNames[0]);
      }

      const unchanged = nextGroups.length === current.length && nextGroups.every((group, index) => group === current[index]);
      return unchanged ? current : nextGroups;
    });
  }, [activeNav?.group, visibleGroupKey]);

  const toggleGroup = (group: string) => {
    setExpandedGroups((current) => (
      current.includes(group) ? current.filter((item) => item !== group) : [...current, group]
    ));
  };

  return { visibleGroupNames, expandedGroupSet, toggleGroup };
}

function NavigationSections({
  visibleNav,
  activeNav,
  visibleGroupNames,
  expandedGroupSet,
  onToggleGroup,
  onNavigate
}: {
  visibleNav: NavigationItem[];
  activeNav?: NavigationItem;
  visibleGroupNames: string[];
  expandedGroupSet: Set<string>;
  onToggleGroup: (group: string) => void;
  onNavigate?: () => void;
}) {
  return (
    <div className="grid gap-1">
      {visibleGroupNames.map((group) => {
        const items = visibleNav.filter((item) => item.group === group);
        const isExpanded = expandedGroupSet.has(group);
        const hasActiveItem = items.some((item) => item.key === activeNav?.key);
        const panelId = `navigation-${group.toLowerCase().replace(/\W+/g, "-")}`;
        return (
          <div key={group} className={clsx("rounded-md px-0.5 py-0.5", hasActiveItem && "bg-white/[0.06]")}>
            <button
              type="button"
              className={clsx(
                "focus-ring flex min-h-[28px] w-full items-center gap-2 rounded-md px-1.5 text-left text-[10px] font-black uppercase tracking-wide transition",
                hasActiveItem ? "text-white" : "text-white/[0.55] hover:bg-white/10 hover:text-white/[0.85]"
              )}
              aria-expanded={isExpanded}
              aria-controls={panelId}
              onClick={() => onToggleGroup(group)}
            >
              <ChevronRight className={clsx("h-3.5 w-3.5 shrink-0 transition-transform", isExpanded && "rotate-90")} />
              <span className="min-w-0 flex-1 truncate">{group}</span>
              <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] leading-none text-white/60">{items.length}</span>
            </button>
            {isExpanded ? (
              <div id={panelId} className="grid gap-0.5 pt-1">
                {items.map((item) => (
                  <NavLink
                    key={item.key}
                    to={item.to}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      clsx(
                        "focus-ring flex min-h-[30px] items-center gap-2 rounded-md px-2 py-0.5 text-[13px] font-semibold transition",
                        isActive ? "bg-white text-[#0B1F3A] shadow-sm ring-1 ring-white/70" : "text-white/75 hover:bg-white/10 hover:text-white"
                      )
                    }
                  >
                    <item.icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </NavLink>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function AppLayout({
  user,
  canAccess,
  onLogout,
  children
}: {
  user: DemoUser;
  canAccess: (route: PortalRouteKey) => boolean;
  onLogout: () => void;
  children: ReactNode;
}) {
  const visibleNav = navigationItems.filter((item) => canAccess(item.key));
  const location = useLocation();
  const activeNav = useMemo(
    () => visibleNav.find((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)),
    [location.pathname, visibleNav]
  );
  const sidebarNav = useExpandedNavGroups(visibleNav, activeNav);
  const fallbackChrome = useMemo<PageChrome>(() => ({
    eyebrow: activeNav?.group,
    title: activeNav?.label ?? "ZPP Connect"
  }), [activeNav]);
  const [pageChrome, setPageChromeState] = useState<PageChromeState | null>(null);
  const visiblePageChrome = pageChrome?.path === location.pathname ? pageChrome : fallbackChrome;
  const pageChromeContext = useMemo(
    () => ({
      setPageChrome: (chrome: PageChrome) => setPageChromeState({ ...chrome, path: location.pathname })
    }),
    [location.pathname]
  );

  return (
    <div className="min-h-screen overflow-x-hidden bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-white/10 bg-gradient-to-b from-[#071A32] via-[#0B1F3A] to-[#061426] text-white shadow-xl shadow-slate-950/[0.15] lg:flex lg:flex-col">
        <div className="flex min-h-12 items-center border-b border-white/10 px-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#145C63] text-white ring-1 ring-white/[0.15]">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-black leading-5">ZPP Connect</p>
              <p className="truncate text-xs font-semibold text-white/60">Emergency Response Portal</p>
            </div>
          </div>
        </div>

        <nav className="scrollbar-soft flex-1 overflow-y-auto px-2 py-1.5">
          <NavigationSections
            visibleNav={visibleNav}
            activeNav={activeNav}
            visibleGroupNames={sidebarNav.visibleGroupNames}
            expandedGroupSet={sidebarNav.expandedGroupSet}
            onToggleGroup={sidebarNav.toggleGroup}
          />
        </nav>

      </aside>

      <div className="lg:pl-60">
        <PageChromeContext.Provider value={pageChromeContext}>
          <Topbar user={user} canAccess={canAccess} onLogout={onLogout} visibleNav={visibleNav} activeNav={activeNav} pageChrome={visiblePageChrome} />
          <main className="mx-auto max-w-[1500px] px-4 py-3 sm:px-5 lg:px-7">{children}</main>
        </PageChromeContext.Provider>
      </div>
    </div>
  );
}

function Topbar({
  user,
  canAccess,
  onLogout,
  visibleNav,
  activeNav,
  pageChrome
}: {
  user: DemoUser;
  canAccess: (route: PortalRouteKey) => boolean;
  onLogout: () => void;
  visibleNav: NavigationItem[];
  activeNav?: NavigationItem;
  pageChrome: PageChrome;
}) {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [compactContext, setCompactContext] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  const mobileNav = useExpandedNavGroups(visibleNav, activeNav);
  const { activeSession } = useApp();
  const { theme, toggleTheme } = useTheme();
  const isDarkTheme = theme === "dark";
  const canAccessNotificationTarget = (href: string) => {
    const route = navigationItems.find((item) => href === item.to || href.startsWith(`${item.to}?`) || href.startsWith(`${item.to}/`));
    return route ? canAccess(route.key) : false;
  };

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const updateCompactContext = () => setCompactContext(media.matches);
    updateCompactContext();
    media.addEventListener("change", updateCompactContext);
    return () => media.removeEventListener("change", updateCompactContext);
  }, []);

  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-[#071A32]/95 text-white shadow-sm shadow-slate-950/20 backdrop-blur">
      <div className="flex min-h-11 items-center justify-between gap-2 px-3 py-1 sm:px-5 lg:gap-4 lg:px-7">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="hidden h-7 w-1 shrink-0 rounded-full bg-[#35A0A6] sm:block" aria-hidden="true" />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-[16px] font-black leading-5 text-white">{pageChrome.title}</h1>
              {pageChrome.actions ? <div className="topbar-actions flex min-w-0 shrink-0 items-center gap-1.5">{pageChrome.actions}</div> : null}
            </div>
            {!compactContext ? (
              <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold leading-4 text-white/[0.62]">
                {pageChrome.eyebrow ? <span className="shrink-0 font-black uppercase tracking-wide text-[#8ED5D7]">{pageChrome.eyebrow}</span> : null}
                {pageChrome.eyebrow && pageChrome.description ? <span className="text-white/25">/</span> : null}
                {pageChrome.description ? <span className="truncate">{pageChrome.description}</span> : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <SessionContext session={activeSession} canOpenSessions={canAccess("sessions")} className="hidden lg:flex" />
          <AccountMenu user={user} canOpenSettings={canAccess("settings")} onLogout={onLogout} className="hidden sm:block" />
          <button
            type="button"
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-white/10 text-white/75 hover:bg-white/[0.15] hover:text-white"
            aria-label={isDarkTheme ? "Switch to light mode" : "Switch to dark mode"}
            title={isDarkTheme ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}
          >
            {isDarkTheme ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <NotificationCenter role={user.roles.join("|")} canAccessTarget={canAccessNotificationTarget} />
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-white/10 text-white/80 hover:bg-white/[0.15] hover:text-white lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </button>
        </div>
      </div>

      {compactContext ? (
        <div className="grid gap-1.5 border-t border-white/10 px-3 py-2 text-white sm:px-5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <AccountMenu user={user} canOpenSettings={canAccess("settings")} onLogout={onLogout} compact className="sm:hidden" />
            <SessionContext session={activeSession} canOpenSessions={canAccess("sessions")} className="ml-auto" compact />
          </div>
          {pageChrome.description ? <p className="line-clamp-2 text-xs font-semibold leading-5 text-white/75">{pageChrome.description}</p> : null}
        </div>
      ) : null}

      {mobileMenuOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 cursor-default bg-slate-950/[0.35]"
            aria-label="Close navigation"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-[min(22rem,calc(100vw-2rem))] flex-col bg-gradient-to-b from-[#071A32] via-[#0B1F3A] to-[#061426] text-white shadow-2xl">
            <div className="flex min-h-14 items-center justify-between gap-3 border-b border-white/10 px-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#145C63] text-white ring-1 ring-white/[0.15]">
                  <ShieldCheck className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-base font-black leading-5">ZPP Connect</p>
                  <p className="truncate text-xs font-semibold text-white/60">Navigation</p>
                </div>
              </div>
              <button
                type="button"
                className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/75 hover:bg-white/10 hover:text-white"
                aria-label="Close navigation"
                onClick={() => setMobileMenuOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <nav className="scrollbar-soft flex-1 overflow-y-auto px-2 py-2">
              <NavigationSections
                visibleNav={visibleNav}
                activeNav={activeNav}
                visibleGroupNames={mobileNav.visibleGroupNames}
                expandedGroupSet={mobileNav.expandedGroupSet}
                onToggleGroup={mobileNav.toggleGroup}
                onNavigate={() => setMobileMenuOpen(false)}
              />
            </nav>
          </div>
        </div>
      ) : null}
    </header>
  );
}

function SessionContext({
  session,
  canOpenSessions,
  className,
  compact = false
}: {
  session?: SessionRecord;
  canOpenSessions: boolean;
  className?: string;
  compact?: boolean;
}) {
  const mode = session?.mode ?? "NO SESSION";
  const tone: BadgeTone = mode === "REAL" ? "danger" : mode === "EXERCISE" ? "gold" : mode === "TRAINING" ? "petrol" : "warning";
  const content = (
    <>
      <Badge tone={tone} className="shrink-0 border-white/15 bg-white/10 px-2 py-0 text-[10px] leading-5 text-white">
        {mode}
      </Badge>
      <span className={clsx("min-w-0 truncate font-bold text-white/75", compact ? "text-[11px]" : "text-xs")}>
        {session?.operationalId ?? "Select a session"}
      </span>
    </>
  );

  return canOpenSessions ? (
    <NavLink
      to="/sessions"
      aria-label={session ? `Current session ${mode} ${session.operationalId}. Open Sessions.` : "No active session. Open Sessions."}
      className={clsx("focus-ring min-w-0 items-center gap-1.5 rounded-md hover:bg-white/10", compact ? "flex max-w-[14rem] px-1 py-0.5" : "px-1.5 py-1", className)}
    >
      {content}
    </NavLink>
  ) : (
    <div aria-label={session ? `Current session ${mode} ${session.operationalId}` : "No active session"} className={clsx("min-w-0 items-center gap-1.5", compact ? "flex max-w-[14rem]" : "flex", className)}>
      {content}
    </div>
  );
}

export function AccountMenu({
  user,
  canOpenSettings,
  onLogout,
  compact = false,
  className
}: {
  user: DemoUser;
  canOpenSettings: boolean;
  onLogout: () => void;
  compact?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const roleSummary = user.roles.length > 1 ? `${user.roles[0]} + ${user.roles.length - 1} more` : user.roles[0] ?? "ZPP Connect user";

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <div className={clsx("relative", compact ? "min-w-[132px] max-w-[170px]" : "min-w-[218px] max-w-[420px]", className)}>
      <button
        type="button"
        className={clsx(
          "focus-ring flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-white/[0.18] bg-white/10 px-2.5 font-semibold text-white shadow-sm shadow-slate-950/[0.15] hover:bg-white/[0.15]",
          compact ? "h-8 text-xs" : "h-8 text-sm"
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 truncate">{user.displayName}</span>
        <ChevronDown className={clsx("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-2xl shadow-slate-950/25"
        >
          <div className="border-b border-border px-3 py-3">
            <p className="truncate text-sm font-black text-foreground">{user.displayName}</p>
            <p className="mt-1 line-clamp-2 text-xs font-semibold leading-5 text-muted-foreground">{roleSummary}</p>
          </div>
          <div className="grid gap-1 p-1.5">
            {canOpenSettings ? (
              <NavLink
                to="/settings"
                role="menuitem"
                className="focus-ring flex min-h-9 items-center gap-2 rounded-md px-2 text-sm font-bold text-foreground hover:bg-muted"
                onClick={() => setOpen(false)}
              >
                <Settings className="h-4 w-4" />
                Account / Settings
              </NavLink>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="focus-ring flex min-h-9 items-center gap-2 rounded-md px-2 text-left text-sm font-bold text-foreground hover:bg-muted"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function StatCard({ item, icon: Icon }: { item: StatItem; icon?: ComponentType<{ className?: string }> }) {
  const toneClass = {
    navy: "bg-[#0B1F3A] text-white",
    petrol: "bg-[#145C63] text-white",
    gold: "bg-slate-100 text-[#0B1F3A]",
    success: "bg-emerald-50 text-emerald-800",
    warning: "bg-amber-50 text-amber-900",
    danger: "bg-red-50 text-red-800"
  }[item.tone ?? "navy"];

  return (
    <section className="rounded-md border border-border bg-card p-3 text-foreground shadow-panel">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-bold text-muted-foreground">{item.label}</p>
          <p className="mt-2 truncate text-2xl font-black leading-none text-foreground">{item.value}</p>
          <p className="mt-1.5 text-xs font-semibold leading-5 text-muted-foreground">{item.detail}</p>
        </div>
        {Icon ? (
          <div className={clsx("flex h-9 w-9 shrink-0 items-center justify-center rounded-md", toneClass)}>
            <Icon className="h-4 w-4" />
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-black text-foreground">{title}</h2>
        {description ? <p className="mt-0.5 max-w-3xl text-sm font-medium text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={clsx("rounded-lg border border-border bg-card text-foreground shadow-panel", className)}>{children}</section>;
}

export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("p-3.5", className)}>{children}</div>;
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: BadgeTone; className?: string }) {
  const tones: Record<BadgeTone, string> = {
    neutral: "border-border bg-muted text-muted-foreground",
    info: "border-[#145C63]/25 bg-[#145C63]/10 text-[#145C63]",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-red-200 bg-red-50 text-red-800",
    gold: "border-[#0B1F3A]/[0.15] bg-[#0B1F3A]/5 text-[#0B1F3A]",
    petrol: "border-[#145C63]/25 bg-[#145C63]/10 text-[#145C63]",
    navy: "border-[#0B1F3A]/20 bg-[#0B1F3A]/10 text-[#0B1F3A]"
  };

  return (
    <span className={clsx("inline-flex max-w-full items-center overflow-hidden whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-bold leading-5", tones[tone], className)}>
      <span className="truncate">{children}</span>
    </span>
  );
}

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  const toneByValue: Record<string, BadgeTone> = {
    active: "petrol",
    "at risk": "danger",
    cancelled: "danger",
    closed: "success",
    complete: "success",
    completed: "success",
    confirmed: "success",
    conflict: "danger",
    critical: "danger",
    current: "success",
    draft: "neutral",
    escalated: "danger",
    incomplete: "warning",
    "in progress": "petrol",
    monitoring: "petrol",
    "no hold": "success",
    open: "petrol",
    overdue: "danger",
    "partially covered": "warning",
    "partially verified": "warning",
    pending: "warning",
    required: "warning",
    restricted: "warning",
    "restricted review": "warning",
    "review due": "warning",
    unconfirmed: "warning",
    unavailable: "neutral",
    unverified: "warning",
    verified: "success"
  };
  const tone = toneByValue[normalized] ?? "neutral";
  return <Badge tone={tone}>{value}</Badge>;
}

export function PriorityBadge({ value }: { value: string }) {
  const tone: BadgeTone = value === "Critical" ? "danger" : value === "Urgent" ? "warning" : "neutral";
  return <Badge tone={tone}>{value}</Badge>;
}

export function SensitivityBadge({ value }: { value: string }) {
  const tone: BadgeTone = value === "Coordinator Only" ? "danger" : value === "Highly Restricted" ? "warning" : "petrol";
  return <Badge tone={tone}>{value}</Badge>;
}

export function CoverageRiskBadge({ value }: { value: string }) {
  const tone: BadgeTone = value === "Critical" ? "danger" : value === "High" ? "warning" : value === "Medium" ? "gold" : "success";
  return <Badge tone={tone}>{value}</Badge>;
}

export function PrivacyNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-[#145C63]/20 bg-[#145C63]/10 px-4 py-3 text-sm font-semibold text-[#145C63]">
      {children}
    </div>
  );
}

export function DataTable<T>({ columns, rows, emptyText = "No records to show" }: { columns: TableColumn<T>[]; rows: T[]; emptyText?: string }) {
  if (!rows.length) return <EmptyState title={emptyText} />;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="scrollbar-soft overflow-x-auto">
        <table className="min-w-full divide-y divide-border text-left text-sm">
          <thead className="bg-muted">
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={clsx("whitespace-nowrap px-3 py-2.5 text-[11px] font-black uppercase tracking-wide text-muted-foreground", column.className)}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-card">
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column.key} className={clsx("px-3 py-2.5 align-top font-semibold text-foreground", column.className)}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="grid gap-3">
      {items.map((item) => (
        <li key={`${item.time}-${item.title}`} className="flex gap-3">
          <div className="flex w-16 shrink-0 justify-end pt-0.5 text-xs font-black text-muted-foreground">{item.time}</div>
          <div className="relative flex flex-1 gap-3">
            <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-[#145C63]" />
            <div className="min-w-0 pb-1">
              <p className="font-bold text-foreground">{item.title}</p>
              <p className="mt-1 text-sm font-medium text-muted-foreground">{item.detail}</p>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border bg-muted px-4 text-center">
      <div>
        <p className="font-bold text-foreground">{title}</p>
        {detail ? <p className="mt-1 text-sm font-semibold text-muted-foreground">{detail}</p> : null}
      </div>
    </div>
  );
}

export function PageIntro({ title, eyebrow, description, children }: { title: string; eyebrow?: string; description: string; children?: ReactNode }) {
  const pageChrome = useContext(PageChromeContext);

  useEffect(() => {
    if (!pageChrome) return;
    pageChrome.setPageChrome({ title, eyebrow, description, actions: children });
  }, [children, description, eyebrow, pageChrome, title]);

  if (pageChrome) return null;

  return (
    <div className="mb-3 grid gap-2 border-b border-border pb-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <div className="min-w-0">
        {eyebrow ? <p className="text-[11px] font-black uppercase tracking-wide text-[#145C63]">{eyebrow}</p> : null}
        <h1 className="mt-0.5 text-[1.65rem] font-black leading-tight text-foreground">{title}</h1>
        <p className="mt-1 max-w-4xl text-sm font-medium leading-5 text-muted-foreground">{description}</p>
      </div>
      {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}

export function LinkedAction({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink to={to} className="focus-ring inline-flex items-center gap-1 text-sm font-black text-[#145C63] hover:text-foreground dark:text-[#7ed7dc]">
      {children}
      <ChevronRight className="h-4 w-4" />
    </NavLink>
  );
}
