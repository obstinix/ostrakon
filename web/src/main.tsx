import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadConnectors } from "./chain/connectors";
import { loadDeployment } from "./chain/deployment";
import { createRuntime } from "./chain/runtime";
import { Boot } from "./components/Boot";
import "./styles/index.css";

const root = createRoot(document.getElementById("root")!);

async function start() {
  const load = await loadDeployment();
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
