import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { clearStoredAuth, getStoredUser, storeAuthenticatedUser } from "./lib/mock-auth";
import type { DemoUser, PortalRouteKey } from "./lib/portal-types";
import { ApiRequestError, api, clearApiSession } from "./lib/api";
import { AppContext, useApp } from "./lib/app-context";
import { isSessionWritable, mostRecentWritableSession } from "./lib/session-safety";
import type { AppProfile, DictionaryMap, SessionRecord, UserContext } from "./lib/types";
import { AppLayout, Badge, LinkedAction, navigationItems, PageIntro, Panel, PanelBody, SectionHeader } from "./components/portal";
import { AlertBox, Loading } from "./components/ui";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ActiveEventPage } from "./pages/ActiveEventPage";
import { VolunteersPage } from "./pages/VolunteersPage";
import { GroupsPage } from "./pages/GroupsPage";
import { RosteringPage } from "./pages/RosteringPage";
import { AssignmentsPage } from "./pages/AssignmentsPage";
import { TrainingPage } from "./pages/TrainingPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { ReadinessPage } from "./pages/ReadinessPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SessionsPage } from "./pages/SessionsPage";
import { RecordsPage } from "./pages/RecordsPage";
import { MatchingPage } from "./pages/MatchingPage";
import { ReleasePage } from "./pages/ReleasePage";
import { TimelinePage } from "./pages/TimelinePage";
import { FilesPage } from "./pages/FilesPage";
import { ReportsPage } from "./pages/ReportsPage";
import { ExercisePage } from "./pages/ExercisePage";
import { AuditPage } from "./pages/AuditPage";
import { AdminPage } from "./pages/AdminPage";

const activeSessionStorageKey = "zpp:activeSessionId";

const routePermissions: Record<PortalRouteKey, string[]> = {
  dashboard: ["session:read"],
  "active-event": ["briefing:read"],
  sessions: ["session:read"],
  "tec-intake": ["enquiry:read"],
  "family-nok": ["family:read"],
  "passenger-src": ["passenger:read"],
  matching: ["matching:read"],
  "release-control": ["release:read"],
  requests: ["request:read"],
  timeline: ["timeline:read"],
  members: ["member:read"],
  groups: ["group:read"],
  rostering: ["roster:read", "roster:read-own"],
  assignments: ["assignment:read"],
  training: ["training:read-all", "training:read-own"],
  documents: ["document:read-own", "document:read-all"],
  readiness: ["readiness:read-own", "readiness:read-group", "readiness:read-all", "readiness:read-summary"],
  "files-import": ["import:create"],
  reports: ["reports:read"],
  "users-access": ["admin:manage"],
  "roles-permissions": ["admin:manage"],
  exercise: ["exercise:manage"],
  audit: ["audit:read"],
  settings: ["session:read"]
};

function WorkflowPage({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) {
  return (
    <>
      <PageIntro eyebrow={eyebrow} title={title} description={description} />
      {children}
    </>
  );
}

function SessionDependentPage({ children }: { children: ReactNode }) {
  const { activeSession } = useApp();
  return (
    <>
      {!activeSession ? (
        <div className="mb-4">
          <AlertBox>No open operational session is selected. Existing information remains read-only; select an eligible session to continue operational work.</AlertBox>
        </div>
      ) : !isSessionWritable(activeSession) ? (
        <div className="mb-4">
          <AlertBox>
            Session {activeSession.operationalId} is closed and read-only. Select another open session to continue operational work.
          </AlertBox>
        </div>
      ) : null}
      {children}
    </>
  );
}

function AccessLimitedPage({ routeKey, user }: { routeKey: PortalRouteKey; user: DemoUser }) {
  const route = navigationItems.find((item) => item.key === routeKey);

  return (
    <>
      <PageIntro
        eyebrow="Role-based access"
        title="Limited Access"
        description="Your current role does not include this module. Contact a system administrator if your operational assignment has changed."
      >
        <Badge tone="neutral">{user.roles.join(" + ")}</Badge>
      </PageIntro>
      <Panel>
        <PanelBody>
          <SectionHeader title={route?.label ?? "Restricted Module"} description="Access is restricted for the active operational profile." />
          <div className="mt-4">
            <LinkedAction to="/dashboard">Return to dashboard</LinkedAction>
          </div>
        </PanelBody>
      </Panel>
    </>
  );
}

function safeReturnPath(search: string) {
  const fallback = "/dashboard";
  const target = new URLSearchParams(search).get("returnTo");
  if (!target || !target.startsWith("/") || target.startsWith("//")) return fallback;
  if (target.startsWith("/login")) return fallback;
  return target;
}

function loginRedirect(pathname: string, search: string) {
  const returnTo = `${pathname}${search}`;
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export function App() {
  const [user, setUser] = useState<DemoUser | undefined>(() => getStoredUser());
  const [apiUser, setApiContextUser] = useState<UserContext | undefined>();
  const [profile, setProfile] = useState<AppProfile | undefined>();
  const [dictionaries, setDictionaries] = useState<DictionaryMap>({});
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState(() => localStorage.getItem(activeSessionStorageKey) ?? "");
  const location = useLocation();
  const navigate = useNavigate();

  const setActiveSessionId = useCallback((id: string) => {
    setActiveSessionIdState(id);
    if (id) localStorage.setItem(activeSessionStorageKey, id);
    else localStorage.removeItem(activeSessionStorageKey);
  }, []);

  const loadAppContext = useCallback(async () => {
    if (!user) {
      setApiContextUser(undefined);
      setProfile(undefined);
      setDictionaries({});
      setSessions([]);
      setActiveSessionId("");
      return;
    }

    try {
      const [me, nextProfile, nextDictionaries, nextSessions] = await Promise.all([
        api.me(),
        api.profile(),
        api.dictionaries(),
        api.sessionsAll()
      ]);
      setApiContextUser(me.user);
      setProfile(nextProfile);
      setDictionaries(nextDictionaries);
      setSessions(nextSessions.data);

      const storedSession = nextSessions.data.find((session) => session.id === activeSessionId);
      const nextActiveSession = (isSessionWritable(storedSession) ? storedSession : undefined) ?? mostRecentWritableSession(nextSessions.data);
      if (nextActiveSession?.id !== activeSessionId) setActiveSessionId(nextActiveSession?.id ?? "");
    } catch (error) {
      console.error("Unable to load operational context", error);
      if (!(error instanceof ApiRequestError) || error.status !== 401) return;
      clearStoredAuth();
      clearApiSession();
      setUser(undefined);
      setApiContextUser(undefined);
      setProfile(undefined);
      setDictionaries({});
      setSessions([]);
      setActiveSessionId("");
    }
  }, [activeSessionId, setActiveSessionId, user]);

  useEffect(() => {
    void loadAppContext();
  }, [loadAppContext]);

  const activeSession = useMemo(() => sessions.find((session) => session.id === activeSessionId), [activeSessionId, sessions]);
  const activeSessionWritable = isSessionWritable(activeSession);

  const verifyActiveSessionWrite = useCallback(async (expectedSessionId?: string | null) => {
    if (!expectedSessionId || expectedSessionId !== activeSessionId) return false;
    try {
      const nextSessions = await api.sessionsAll();
      setSessions(nextSessions.data);
      const expectedSession = nextSessions.data.find((session) => session.id === expectedSessionId);
      if (isSessionWritable(expectedSession)) return true;
      setActiveSessionId(mostRecentWritableSession(nextSessions.data)?.id ?? "");
      return false;
    } catch {
      return false;
    }
  }, [activeSessionId, setActiveSessionId]);

  const permissionSet = useMemo(() => new Set(apiUser?.permissions ?? []), [apiUser?.permissions]);
  const appContextValue = useMemo(
    () => ({
      user: apiUser,
      portalUser: user,
      profile,
      dictionaries,
      sessions,
      activeSession,
      activeSessionWritable,
      setActiveSessionId,
      verifyActiveSessionWrite,
      reload: loadAppContext,
      can: (permission: string) => permissionSet.has(permission)
    }),
    [activeSession, activeSessionWritable, apiUser, dictionaries, loadAppContext, permissionSet, profile, sessions, setActiveSessionId, user, verifyActiveSessionWrite]
  );

  const handleLogin = (nextUser: UserContext) => {
    const nextPortalUser = storeAuthenticatedUser(nextUser);
    setApiContextUser(nextUser);
    setUser(nextPortalUser);
    const currentSearch = window.location.search || location.search;
    navigate(safeReturnPath(currentSearch), { replace: true });
  };

  const handleLogout = () => {
    void api.logout().catch((error) => {
      console.error("Unable to close session", error);
    }).finally(() => {
      flushSync(() => {
        clearStoredAuth();
        clearApiSession();
        setApiContextUser(undefined);
        setProfile(undefined);
        setDictionaries({});
        setSessions([]);
        setActiveSessionId("");
        setUser(undefined);
      });
      navigate("/login", { replace: true });
    });
  };

  const hasRouteCapability = useCallback((routeKey: PortalRouteKey) => {
    const required = routePermissions[routeKey] ?? ["session:read"];
    return required.some((permission) => permissionSet.has(permission));
  }, [permissionSet]);

  const protect = (routeKey: PortalRouteKey, element: ReactNode) => {
    if (!user) return <Navigate to={loginRedirect(location.pathname, location.search)} replace />;
    const canOpen = Boolean(apiUser) && hasRouteCapability(routeKey);
    const canNavigate = (key: PortalRouteKey) => Boolean(apiUser) && hasRouteCapability(key);
    return (
      <AppContext.Provider value={appContextValue}>
        <AppLayout user={user} canAccess={canNavigate} onLogout={handleLogout}>
          {!apiUser ? <Loading label="Loading authenticated profile" /> : canOpen ? element : <AccessLimitedPage routeKey={routeKey} user={user} />}
        </AppLayout>
      </AppContext.Provider>
    );
  };

  return (
    <Routes>
      <Route path="/" element={<Navigate to={user ? "/dashboard" : "/login"} replace />} />
      <Route path="/login" element={user ? <Navigate to={safeReturnPath(location.search)} replace /> : <LoginPage onLogin={handleLogin} />} />
      <Route
        path="/dashboard"
        element={protect(
          "dashboard",
          <WorkflowPage eyebrow="Operational overview" title="Dashboard" description="Next: follow the Start here steps in order, then review any attention items.">
            {user ? <DashboardPage portalUser={user} canAccessRoute={hasRouteCapability} /> : null}
          </WorkflowPage>
        )}
      />
      <Route path="/active-event" element={protect("active-event", <ActiveEventPage />)} />
      <Route
        path="/sessions"
        element={protect(
          "sessions",
          <WorkflowPage eyebrow="Session control" title="Sessions" description="Next: confirm the active exercise or real event before creating or editing records.">
            <SessionsPage />
          </WorkflowPage>
        )}
      />
      <Route
        path="/tec-intake"
        element={protect(
          "tec-intake",
          <WorkflowPage eyebrow="Call intake" title="TEC Intake" description="Next: record the caller and enquiry details. Do not disclose passenger or casualty status.">
            <SessionDependentPage><RecordsPage kind="enquiries" /></SessionDependentPage>
          </WorkflowPage>
        )}
      />
      <Route path="/next-of-kin" element={<Navigate to={user ? "/family-nok" : "/login"} replace />} />
      <Route
        path="/family-nok"
        element={protect(
          "family-nok",
          <WorkflowPage eyebrow="Family assistance" title="Family / NOK" description="Next: capture contact details, then verify relationship before any disclosure.">
            <SessionDependentPage><RecordsPage kind="family-records" /></SessionDependentPage>
          </WorkflowPage>
        )}
      />
      <Route
        path="/passenger-src"
        element={protect(
          "passenger-src",
          <WorkflowPage eyebrow="Passenger records" title="Passenger / SRC" description="Next: confirm source status and holds before records are used for matching or release.">
            <SessionDependentPage><RecordsPage kind="passenger-records" /></SessionDependentPage>
          </WorkflowPage>
        )}
      />
      <Route
        path="/matching"
        element={protect(
          "matching",
          <WorkflowPage eyebrow="Reconciliation" title="Matching" description="Next: review one match, resolve holds, then mark verified only when evidence is clear.">
            <SessionDependentPage><MatchingPage /></SessionDependentPage>
          </WorkflowPage>
        )}
      />
      <Route
        path="/release-control"
        element={protect(
          "release-control",
          <WorkflowPage eyebrow="Controlled release" title="Release Control" description="Next: complete identity and hold checks before preparing any release action.">
            <SessionDependentPage><ReleasePage /></SessionDependentPage>
          </WorkflowPage>
        )}
      />
      <Route
        path="/requests"
        element={protect(
          "requests",
          <WorkflowPage eyebrow="Welfare requests" title="Requests" description="Next: open urgent requests first, assign an owner, then update the status.">
            <SessionDependentPage><RecordsPage kind="requests" /></SessionDependentPage>
          </WorkflowPage>
        )}
      />
      <Route
        path="/timeline"
        element={protect(
          "timeline",
          <WorkflowPage eyebrow="Case history" title="Timeline" description="Next: add a concise note after each decision, handover or status change.">
            <SessionDependentPage><TimelinePage /></SessionDependentPage>
          </WorkflowPage>
      )}
      />
      <Route path="/volunteers" element={<Navigate to={user ? "/members" : "/login"} replace />} />
      <Route path="/members" element={protect("members", <VolunteersPage />)} />
      <Route path="/groups" element={protect("groups", <SessionDependentPage><GroupsPage /></SessionDependentPage>)} />
      <Route path="/rostering" element={protect("rostering", user ? <RosteringPage user={user} /> : null)} />
      <Route path="/assignments" element={protect("assignments", <SessionDependentPage><AssignmentsPage /></SessionDependentPage>)} />
      <Route path="/training" element={protect("training", <TrainingPage />)} />
      <Route path="/documents" element={protect("documents", <DocumentsPage />)} />
      <Route path="/readiness" element={protect("readiness", <ReadinessPage />)} />
      <Route
        path="/files-import"
        element={protect(
          "files-import",
          <WorkflowPage eyebrow="Data exchange" title="Files / Import" description="Next: upload the active manifest or support file, then check import results.">
            <SessionDependentPage><FilesPage /></SessionDependentPage>
          </WorkflowPage>
        )}
      />
      <Route
        path="/reports"
        element={protect(
          "reports",
          <WorkflowPage eyebrow="Exports" title="Reports" description="Next: choose the report needed for handover, briefing or authorized export.">
            <ReportsPage />
          </WorkflowPage>
        )}
      />
      <Route
        path="/users-access"
        element={protect(
          "users-access",
          <WorkflowPage eyebrow="Administration" title="Users & Access" description="Next: find the account, review current access, then use the dedicated action you need.">
            <AdminPage initialTab="users" />
          </WorkflowPage>
        )}
      />
      <Route
        path="/roles-permissions"
        element={protect(
          "roles-permissions",
          <WorkflowPage eyebrow="Administration" title="Roles & Permissions" description="Next: review protected roles or create a custom role from existing capabilities.">
            <AdminPage initialTab="roles" />
          </WorkflowPage>
        )}
      />
      <Route
        path="/exercise"
        element={protect(
          "exercise",
          <WorkflowPage eyebrow="Exercise control" title="Exercise" description="Next: run the current inject, record observations, then brief the next action.">
            <SessionDependentPage><ExercisePage /></SessionDependentPage>
          </WorkflowPage>
        )}
      />
      <Route
        path="/audit"
        element={protect(
          "audit",
          <WorkflowPage eyebrow="Governance" title="Audit" description="Next: search the user, record or time window you need to verify.">
            <AuditPage />
          </WorkflowPage>
        )}
      />
      <Route path="/settings" element={protect("settings", user ? <SettingsPage user={user} /> : null)} />
      <Route path="*" element={<Navigate to={user ? "/dashboard" : "/login"} replace />} />
    </Routes>
  );
}
