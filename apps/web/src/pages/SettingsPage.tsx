import type { DemoUser } from "../lib/portal-types";
import { PageIntro, Panel, PanelBody, PrivacyNote, SectionHeader } from "../components/portal";

export function SettingsPage({ user }: { user: DemoUser }) {
  return (
    <>
      <PageIntro
        eyebrow="System settings"
        title="Settings"
        description="Profile, sign-in and privacy settings status."
      />
      <div className="mt-3 grid gap-5 lg:grid-cols-2">
        <Panel>
          <PanelBody>
            <SectionHeader title="Current User" />
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
              <div className="rounded-md border border-border bg-muted p-3"><dt className="font-black text-muted-foreground">Roles</dt><dd className="mt-1 font-bold text-foreground">{user.roles.join(" + ")}</dd></div>
              <div className="rounded-md border border-border bg-muted p-3"><dt className="font-black text-muted-foreground">Access</dt><dd className="mt-1 font-bold text-foreground">{user.accessLevel}</dd></div>
              <div className="rounded-md border border-border bg-muted p-3"><dt className="font-black text-muted-foreground">Sign-in</dt><dd className="mt-1 font-bold text-foreground">{user.authMethod}</dd></div>
            </dl>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <SectionHeader title="Authentication" />
            <div className="mt-3 grid gap-2">
              <div className="rounded-md border border-border bg-muted p-3 text-sm font-semibold text-foreground">
                Sign-in uses assigned operational accounts.
              </div>
              <div className="rounded-md border border-border bg-muted p-3 text-sm font-semibold text-foreground">
                Role assignments control which modules and actions are available.
              </div>
              <div className="rounded-md border border-border bg-muted p-3 text-sm font-semibold text-foreground">
                Notifications highlight items requiring attention for your active assignments.
              </div>
            </div>
          </PanelBody>
        </Panel>
      </div>
      <div className="mt-4">
        <PrivacyNote>Privacy controls apply to Next of Kin records, member contact data and operational documents. Restricted access should be reviewed regularly.</PrivacyNote>
      </div>
    </>
  );
}
