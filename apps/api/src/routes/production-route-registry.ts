import type { Router } from "express";

export type ProductionRouteCategory = "A" | "E" | "F";
export type ProductionRouteAuthority = "postgres" | "stateless" | "deferred";

export type ProductionRouteClaim = {
  method: string;
  path: string;
  owner: string;
  category: ProductionRouteCategory;
  authority: ProductionRouteAuthority;
  memoryBacked: false;
};

type ExpressRouteLayer = {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
  };
};

function canonicalPath(path: string) {
  return path.replace(/:[^/]+/g, ":param").replace(/\/+$/, "") || "/";
}

export function declaredRoutes(router: Router) {
  const layers = (router as unknown as { stack?: ExpressRouteLayer[] }).stack ?? [];
  return layers.flatMap((layer) => {
    if (!layer.route) return [];
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    return paths.flatMap((path) => Object.entries(layer.route!.methods)
      .filter(([, enabled]) => enabled)
      .map(([method]) => ({ method: method.toUpperCase(), path })));
  });
}

export function createProductionRouteRegistry() {
  const claims: ProductionRouteClaim[] = [];
  const claimed = new Map<string, ProductionRouteClaim>();

  function add(claim: ProductionRouteClaim) {
    const key = `${claim.method.toUpperCase()} ${canonicalPath(claim.path)}`;
    const previous = claimed.get(key);
    if (previous) {
      throw new Error(`Production route collision: ${key} is claimed by ${previous.owner} and ${claim.owner}`);
    }
    claimed.set(key, claim);
    claims.push(claim);
  }

  return {
    claimRouter(
      owner: string,
      category: ProductionRouteCategory,
      authority: ProductionRouteAuthority,
      router: Router,
    ) {
      for (const route of declaredRoutes(router)) add({ ...route, owner, category, authority, memoryBacked: false });
    },
    claim(claim: Omit<ProductionRouteClaim, "memoryBacked">) {
      add({ ...claim, memoryBacked: false });
    },
    manifest() {
      return [...claims].sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
    },
  };
}
