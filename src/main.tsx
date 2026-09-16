import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Register only a retirement worker: older releases cached the entire game,
// including invalid audio range responses. No offline playback is promised.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
