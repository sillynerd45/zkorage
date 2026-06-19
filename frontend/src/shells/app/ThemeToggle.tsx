import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

// Variant B adds a light/dark toggle (its reference has one). Light is the baseline; dark is opt-in and
// stored in localStorage. The `.dark` class is only ever set here, so Variant A always stays light.
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
