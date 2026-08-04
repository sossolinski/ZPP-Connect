import { createContext, useContext } from "react";
import type { AppProfile, DictionaryMap, SessionRecord, UserContext } from "./types";
import type { DemoUser } from "./portal-types";

export type AppState = {
  user?: UserContext;
  portalUser?: DemoUser;
  profile?: AppProfile;
  dictionaries: DictionaryMap;
  sessions: SessionRecord[];
  activeSession?: SessionRecord;
  activeSessionWritable: boolean;
  setActiveSessionId: (id: string) => void;
  verifyActiveSessionWrite: (expectedSessionId?: string | null) => Promise<boolean>;
  reload: () => Promise<void>;
  can: (permission: string) => boolean;
};

export const AppContext = createContext<AppState | undefined>(undefined);

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppContext");
  return value;
}
