import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

type Theme = "light" | "dark";
type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
};

const themeStorageKey = "zpp:theme";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function storedTheme(): Theme | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const value = window.localStorage.getItem(themeStorageKey);
    return value === "dark" || value === "light" ? value : undefined;
  } catch {
    return undefined;
  }
}

function preferredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

function persistTheme(theme: Theme) {
  try {
    window.localStorage.setItem(themeStorageKey, theme);
  } catch {
    // Theme persistence is a convenience; rendering should continue if storage is unavailable.
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => storedTheme() ?? preferredTheme());

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined" || storedTheme()) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setThemeState(query.matches ? "dark" : "light");
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  const setTheme = useCallback((nextTheme: Theme) => {
    persistTheme(nextTheme);
    setThemeState(nextTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const nextTheme = current === "dark" ? "light" : "dark";
      persistTheme(nextTheme);
      return nextTheme;
    });
  }, []);

  const value = useMemo(() => ({ theme, toggleTheme, setTheme }), [setTheme, theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
