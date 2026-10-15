/** Shown when there is no usable deployment.json: explains how to get one instead of a blank page. */
export function Boot({ reason }: { reason: "missing" | "invalid" }) {
  return (
    <main className="boot" id="main">
      <p className="eyebrow">Ostrakon</p>
      <h1>No contract to read yet</h1>
      {reason === "missing" ? (
        <p>
          The app could not find <code>/deployment.json</code>, which says where the contract lives. Locally, it is
          written by the dev command after it starts a chain and deploys:
        </p>
      ) : (
        <p>
          <code>/deployment.json</code> exists but is not in the expected shape. Regenerate it with the dev command:
        </p>
      )}
      <pre className="cmd">npm run dev</pre>
      <p className="muted">Then reload this page.</p>
    </main>
  );
}
