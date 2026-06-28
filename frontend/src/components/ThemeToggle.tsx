import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

// Light/dark toggle, shared by the app shell (sidebar + top bar) and the public marketing top bar. Light is
// the baseline; dark is opt-in and stored in localStorage. The `.dark` class is only ever set here, so the
// stored preference is the single source of truth across both shells.
function stored(): boolean {
  try {
    return localStorage.getItem("zkorage-theme") === "dark";
  } catch {
    return false;
  }
}

export function ThemeToggle() {
  const [dark, setDark] = useState(stored);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("zkorage-theme", dark ? "dark" : "light");
    } catch {
      /* storage blocked, no-op */
    }
  }, [dark]);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setDark((d) => !d)}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
