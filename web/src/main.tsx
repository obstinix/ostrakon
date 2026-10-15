import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadConnectors } from "./chain/connectors";
import { loadDeployment } from "./chain/deployment";
import { createRuntime } from "./chain/runtime";
import { Boot } from "./components/Boot";
import "./styles/index.css";

const root = createRoot(document.getElementById("root")!);

/** Fetch the core faces alongside deployment.json so the first paint doesn't re-wrap on font swap. */
function fontsReady(): Promise<unknown> {
  const faces = ['400 1em "Public Sans"', '600 1em "Public Sans"', '700 1em "Public Sans"', '400 1em "IBM Plex Mono"', '500 1em "IBM Plex Mono"', '520 1em "Fraunces Variable"'];
  const all = Promise.all(faces.map((f) => document.fonts.load(f))).catch(() => undefined);
  return Promise.race([all, new Promise((r) => setTimeout(r, 800))]);
}

async function start() {
  const [load] = await Promise.all([loadDeployment(), fontsReady()]);
  if (load.status !== "ok") {
    root.render(
      <StrictMode>
        <Boot reason={load.status} />
      </StrictMode>,
    );
    return;
  }
  const runtime = createRuntime(load.deployment, await loadConnectors());
  root.render(
    <StrictMode>
      <App runtime={runtime} />
    </StrictMode>,
  );
}

void start();
