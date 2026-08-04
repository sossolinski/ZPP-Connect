import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Building2, Loader2, Mail, ShieldCheck, UserRound } from "lucide-react";
import { api, type AuthenticationDiscovery, type DevelopmentAuthUser, type ProductAuthenticationMethod } from "../lib/api";
import type { UserContext } from "../lib/types";
import { Badge } from "../components/portal";

const methodLabels: Record<ProductAuthenticationMethod, string> = {
  MICROSOFT_SSO: "Microsoft",
  EMAIL_PASSWORD: "Email sign-in"
};

function genericLoginMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "We could not continue sign-in. Check the selected method and try again.";
}

export function LoginPage({ onLogin }: { onLogin: (user: UserContext) => void }) {
  const [identifier, setIdentifier] = useState("");
  const [discovery, setDiscovery] = useState<AuthenticationDiscovery | undefined>();
  const [productNotice, setProductNotice] = useState("");
  const [developmentAccessEnabled, setDevelopmentAccessEnabled] = useState(false);
  const [developmentUsers, setDevelopmentUsers] = useState<DevelopmentAuthUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedMethod, setSelectedMethod] = useState<ProductAuthenticationMethod>("MICROSOFT_SSO");
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [checkingOptions, setCheckingOptions] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadDevelopmentAccess() {
      try {
        const config = await api.authConfig();
        if (cancelled) return;
        setDevelopmentAccessEnabled(config.developmentAccessEnabled);
        if (!config.developmentAccessEnabled) return;
        const users = await api.developmentUsers();
        if (cancelled) return;
        setDevelopmentUsers(users.data);
        const firstUser = users.data[0];
        if (firstUser) {
          setSelectedUserId(firstUser.userId);
          setSelectedMethod(firstUser.permittedMethods[0] ?? "MICROSOFT_SSO");
        }
      } catch {
        if (!cancelled) setDevelopmentAccessEnabled(false);
      } finally {
        if (!cancelled) setLoadingConfig(false);
      }
    }

    void loadDevelopmentAccess();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedDevelopmentUser = useMemo(
    () => developmentUsers.find((user) => user.userId === selectedUserId),
    [developmentUsers, selectedUserId]
  );
  const selectableMethods = selectedDevelopmentUser?.permittedMethods.length ? selectedDevelopmentUser.permittedMethods : [];

  useEffect(() => {
    if (!selectedDevelopmentUser) return;
    if (!selectedDevelopmentUser.permittedMethods.includes(selectedMethod)) {
      setSelectedMethod(selectedDevelopmentUser.permittedMethods[0] ?? "MICROSOFT_SSO");
    }
  }, [selectedDevelopmentUser, selectedMethod]);

  const checkOptions = async () => {
    setCheckingOptions(true);
    setError("");
    setProductNotice("");
    try {
      const result = await api.authDiscovery(identifier);
      setDiscovery(result);
    } catch (nextError) {
      setDiscovery(undefined);
      setError(genericLoginMessage(nextError));
    } finally {
      setCheckingOptions(false);
    }
  };

  const productMethods = discovery?.accountEligible ? discovery.permittedMethods : (["MICROSOFT_SSO", "EMAIL_PASSWORD"] as ProductAuthenticationMethod[]);
  const canShowMicrosoft = productMethods.includes("MICROSOFT_SSO");
  const canShowEmail = productMethods.includes("EMAIL_PASSWORD");
  const productMethodNotice = developmentAccessEnabled ? "Use Development access below to enter this workspace." : "This sign-in method is not available yet.";

  const completeDevelopmentLogin = async () => {
    if (!selectedDevelopmentUser || !selectableMethods.length) return;
    setSigningIn(true);
    setError("");
    try {
      const result = await api.developmentLogin({ userId: selectedDevelopmentUser.userId, method: selectedMethod });
      onLogin(result.user);
    } catch (nextError) {
      setError(genericLoginMessage(nextError));
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <main className="min-h-screen overflow-x-hidden bg-background px-3 py-6 text-foreground sm:px-4 sm:py-8">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] w-full max-w-6xl min-w-0 items-center gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(420px,0.75fr)]">
        <section className="min-w-0">
          <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-[#0B1F3A] text-white shadow-panel ring-1 ring-border">
            <ShieldCheck className="h-7 w-7" />
          </div>
          <Badge tone="petrol" className="mt-6">Emergency Response Portal</Badge>
          <h1 className="mt-4 text-4xl font-black tracking-normal text-foreground sm:text-5xl">ZPP Connect</h1>
          <p className="mt-3 text-xl font-bold text-[#145C63] dark:text-[#8ED5D7]">Calm workspace for operational response teams</p>
          <p className="mt-5 max-w-2xl text-base font-medium leading-7 text-muted-foreground">
            Sign in with your assigned account to open briefings, tasks, readiness records and authorized case work.
          </p>
          <div className="mt-6 grid max-w-xl gap-3 text-sm font-semibold text-muted-foreground">
            <div className="rounded-md border border-border bg-card px-4 py-3">Access follows your account configuration in Users & Access.</div>
            <div className="rounded-md border border-border bg-card px-4 py-3">Training, exercise and real-event sessions stay clearly separated after sign-in.</div>
          </div>
        </section>

        <section className="min-w-0 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-panel sm:p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#145C63] text-white">
              <UserRound className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-black text-foreground">Sign in</h2>
              <p className="text-sm font-semibold text-muted-foreground">Use your assigned ZPP Connect account</p>
            </div>
          </div>

          <form
            className="mt-5 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void checkOptions();
            }}
          >
            <label className="grid gap-1.5 text-sm font-bold text-foreground">
              Work email
              <input
                className="focus-ring h-11 min-w-0 rounded-md border border-border bg-background px-3 text-sm font-semibold text-foreground"
                type="email"
                value={identifier}
                placeholder="name@example.org"
                autoComplete="username"
                onChange={(event) => setIdentifier(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="focus-ring inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border bg-muted px-4 text-sm font-black text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
              disabled={checkingOptions || !identifier.trim()}
            >
              {checkingOptions ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
              Check sign-in options
            </button>
          </form>

          <div className="mt-5 grid gap-3">
            {canShowMicrosoft ? (
              <button
                type="button"
                className="focus-ring flex min-h-12 min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-background px-4 py-3 text-left text-sm font-black text-foreground hover:bg-muted"
                onClick={() => setProductNotice(productMethodNotice)}
              >
                <span className="inline-flex items-center gap-2"><Building2 className="h-4 w-4" /> Continue with Microsoft</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ) : null}
            {canShowEmail ? (
              <button
                type="button"
                className="focus-ring flex min-h-12 min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-background px-4 py-3 text-left text-sm font-black text-foreground hover:bg-muted"
                onClick={() => setProductNotice(productMethodNotice)}
              >
                <span className="inline-flex items-center gap-2"><Mail className="h-4 w-4" /> Sign in with email</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ) : null}
          </div>

          <div aria-live="polite" className="mt-4 grid gap-2">
            {discovery ? (
              <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm font-semibold text-muted-foreground">
                <p>{discovery.message}</p>
                {discovery.accountEligible && discovery.permittedMethods.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {discovery.permittedMethods.map((method) => <Badge key={method} tone="petrol">{methodLabels[method]}</Badge>)}
                  </div>
                ) : null}
              </div>
            ) : null}
            {productNotice ? <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm font-semibold text-muted-foreground">{productNotice}</p> : null}
            {error ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">{error}</p> : null}
          </div>

          {developmentAccessEnabled ? (
            <div className="mt-5 rounded-lg border border-[#145C63]/25 bg-[#145C63]/10 p-3">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-sm font-black text-foreground">Development access</h3>
                  <p className="mt-1 text-xs font-semibold leading-5 text-muted-foreground">Select an account configured in Users & Access.</p>
                </div>
                <Badge tone="petrol">{developmentUsers.length} accounts</Badge>
              </div>

              <div className="mt-3 grid gap-3">
                <label className="grid gap-1.5 text-sm font-bold text-foreground">
                  Account
                  <select
                    className="app-topbar-select focus-ring h-11 min-w-0 rounded-md border border-border bg-background px-3 text-sm font-semibold text-foreground"
                    value={selectedUserId}
                    onChange={(event) => setSelectedUserId(event.target.value)}
                    disabled={signingIn || loadingConfig || !developmentUsers.length}
                  >
                    {developmentUsers.map((user) => (
                      <option key={user.userId} value={user.userId}>
                        {user.displayName} · {user.email}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-1.5 text-sm font-bold text-foreground">
                  Sign-in method
                  <select
                    className="app-topbar-select focus-ring h-11 min-w-0 rounded-md border border-border bg-background px-3 text-sm font-semibold text-foreground"
                    value={selectedMethod}
                    onChange={(event) => setSelectedMethod(event.target.value as ProductAuthenticationMethod)}
                    disabled={signingIn || !selectableMethods.length}
                  >
                    {selectableMethods.map((method) => (
                      <option key={method} value={method}>{methodLabels[method]}</option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  className="focus-ring inline-flex h-11 items-center justify-center gap-2 rounded-md bg-[#145C63] px-4 text-sm font-black text-white hover:bg-[#0F4D53] disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void completeDevelopmentLogin()}
                  disabled={signingIn || loadingConfig || !selectedDevelopmentUser || !selectableMethods.length}
                >
                  {signingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  Enter ZPP Connect
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
