import { describe, expect, it } from "vitest";
import { resolveConfig, validateRuntimeConfig } from "./config.js";

describe("runtime configuration boundaries", () => {
  it("rejects unknown authentication and persistence modes", () => {
    expect(() => resolveConfig({ NODE_ENV: "test", AUTH_MODE: "magic" })).toThrow(/AUTH_MODE/);
    expect(() => resolveConfig({ NODE_ENV: "test", PERSISTENCE_MODE: "filesystem" })).toThrow(/PERSISTENCE_MODE/);
  });

  it("forbids development authentication and memory persistence in production", () => {
    const devAuth = resolveConfig({
      NODE_ENV: "production",
      AUTH_MODE: "dev",
      PERSISTENCE_MODE: "postgres",
      DATABASE_URL: "postgresql://example.invalid/zpp"
    });
    expect(() => validateRuntimeConfig(devAuth)).toThrow(/AUTH_MODE=dev is forbidden/);

    const memory = resolveConfig({
      NODE_ENV: "production",
      AUTH_MODE: "entra",
      PERSISTENCE_MODE: "memory",
      ENTRA_ISSUER: "https://issuer.example",
      ENTRA_AUDIENCE: "zpp-api",
      ENTRA_JWKS_URI: "https://issuer.example/keys"
    });
    expect(() => validateRuntimeConfig(memory)).toThrow(/PERSISTENCE_MODE=postgres/);
  });

  it("requires explicit PostgreSQL and Entra configuration", () => {
    const missingDatabase = resolveConfig({ NODE_ENV: "development", AUTH_MODE: "dev", PERSISTENCE_MODE: "postgres" });
    expect(() => validateRuntimeConfig(missingDatabase)).toThrow(/DATABASE_URL/);

    const missingEntra = resolveConfig({
      NODE_ENV: "production",
      AUTH_MODE: "entra",
      PERSISTENCE_MODE: "postgres",
      DATABASE_URL: "postgresql://example.invalid/zpp"
    });
    expect(() => validateRuntimeConfig(missingEntra)).toThrow(/ENTRA_ISSUER/);
  });

  it("allows the memory adapter only for automated tests", () => {
    const testConfig = resolveConfig({ NODE_ENV: "test", AUTH_MODE: "dev", PERSISTENCE_MODE: "memory" });
    expect(() => validateRuntimeConfig(testConfig)).not.toThrow();
  });
});
