import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router";
import { useEffect } from "react";
import { RuntimeProvider, type Runtime } from "./chain/runtime";
import { WalletProvider } from "./chain/wallet";
import { HealthNotice } from "./components/HealthNotice";
import { NetworkBar } from "./components/NetworkBar";
import { AuditPage } from "./routes/Audit";
import { CreatePage } from "./routes/Create";
import { ElectionPage } from "./routes/Election";
import { HowPage } from "./routes/How";
import { LedgerPage } from "./routes/Ledger";
import { ManagePage } from "./routes/Manage";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function Shell() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <NetworkBar />
      <header className="masthead">
        <NavLink to="/" className="wordmark" aria-label="Ostrakon, elections ledger">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M6 9 L22 4 L27 15 L20 27 L8 24 L4 15 Z" />
            <path className="mark-cut" d="M10 13 L20 11 M11 18 L22 16" />
          </svg>
          Ostrakon
        </NavLink>
        <nav aria-label="Primary">
          <NavLink to="/" end>
            Ledger
          </NavLink>
          <NavLink to="/audit">Audit</NavLink>
          <NavLink to="/new">New election</NavLink>
          <NavLink to="/how">How it works</NavLink>
        </nav>
      </header>
      <HealthNotice />
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<LedgerPage />} />
          <Route path="/e/:id" element={<ElectionPage />} />
          <Route path="/e/:id/manage" element={<ManagePage />} />
          <Route path="/new" element={<CreatePage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/how" element={<HowPage />} />
          <Route
            path="*"
            element={
              <section className="page">
                <h1>Not found</h1>
                <p>
                  There's nothing at this address. <NavLink to="/">Back to the ledger</NavLink>.
                </p>
              </section>
            }
          />
        </Routes>
      </main>
      <footer className="colophon">
        <p>
          Ostrakon is a teaching DApp. Ballots are <strong>public</strong> on chain: see{" "}
          <NavLink to="/how">How it works</NavLink>.
        </p>
        <p className="muted">Developed by Piyush Pandey (obstinix).</p>
      </footer>
    </>
  );
}

export function App({ runtime }: { runtime: Runtime }) {
  return (
    <RuntimeProvider runtime={runtime}>
      <WalletProvider>
        <BrowserRouter>
          <ScrollToTop />
          <Shell />
        </BrowserRouter>
      </WalletProvider>
    </RuntimeProvider>
  );
}
