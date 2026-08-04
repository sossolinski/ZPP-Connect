import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config();

export type AuthMode = "dev" | "entra";
export type PersistenceMode = "memory" | "postgres";

export type AppConfig = {
  nodeEnv: string;
  databaseUrl?: string;
  persistenceMode: PersistenceMode;
  port: number;
  appOrigin: string;
  appProfile: string;
  dataDir: string;
  authMode: AuthMode;
  devUserEmail: string;
  entraIssuer?: string;
  entraAudience?: string;
  entraJwksUri?: string;
  logLevel: string;
};

function enumValue<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const authMode = enumValue("AUTH_MODE", env.AUTH_MODE ?? (nodeEnv === "production" ? "entra" : "dev"), ["dev", "entra"] as const);
  const persistenceMode = enumValue(
    "PERSISTENCE_MODE",
    env.PERSISTENCE_MODE ?? (nodeEnv === "test" ? "memory" : "postgres"),
    ["memory", "postgres"] as const
  );

  return {
    nodeEnv,
    databaseUrl: env.DATABASE_URL,
    persistenceMode,
    port: Number(env.API_PORT ?? 4000),
    appOrigin: env.APP_ORIGIN ?? "http://localhost:5173",
    appProfile: env.APP_PROFILE ?? "lot-zpp",
    dataDir: env.DATA_DIR ?? path.resolve(process.cwd(), "../../storage"),
    authMode,
    devUserEmail: env.DEV_USER_EMAIL ?? "coordinator@lot.pl",
    entraIssuer: env.ENTRA_ISSUER ?? env.JWT_ISSUER,
    entraAudience: env.ENTRA_AUDIENCE ?? env.JWT_AUDIENCE,
    entraJwksUri: env.ENTRA_JWKS_URI ?? env.JWKS_URI,
    logLevel: env.LOG_LEVEL ?? (nodeEnv === "test" ? "silent" : "info")
  };
}

export function validateRuntimeConfig(value: AppConfig) {
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw new Error("API_PORT must be a valid TCP port");
  }
  if (value.nodeEnv === "production" && value.authMode === "dev") {
    throw new Error("AUTH_MODE=dev is forbidden when NODE_ENV=production");
  }
  if (value.nodeEnv === "production" && value.persistenceMode !== "postgres") {
    throw new Error("PERSISTENCE_MODE=postgres is required when NODE_ENV=production");
  }
  if (value.persistenceMode === "memory" && value.nodeEnv !== "test") {
    throw new Error("PERSISTENCE_MODE=memory is reserved for automated tests");
  }
  if (value.persistenceMode === "postgres" && !value.databaseUrl) {
    throw new Error("DATABASE_URL is required when PERSISTENCE_MODE=postgres");
  }
  if (value.authMode === "entra" && (!value.entraIssuer || !value.entraAudience || !value.entraJwksUri)) {
    throw new Error("AUTH_MODE=entra requires ENTRA_ISSUER, ENTRA_AUDIENCE and ENTRA_JWKS_URI");
  }
}

export const config = resolveConfig();
