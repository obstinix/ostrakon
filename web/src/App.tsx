import { useElections } from "./chain/hooks";
import { RuntimeProvider, useRuntime, type Runtime } from "./chain/runtime";
import { WalletProvider } from "./chain/wallet";

function Probe() {
  const { health, runtime } = useRuntime();
  const elections = useElections();
  return (
    <main id="main">
      <p data-testid="health">
        rpc={health.rpc} code={health.code} block={health.block?.toString() ?? "-"} contract={runtime.deployment.address}
      </p>
      <ul>
        {elections.data?.map((e) => (
          <li key={e.id.toString()}>
            #{e.id.toString()} {e.name} · {e.phase} · {e.totalVotes} votes
          </li>
        ))}
      </ul>
    </main>
  );
}

export function App({ runtime }: { runtime: Runtime }) {
  return (
    <RuntimeProvider runtime={runtime}>
      <WalletProvider>
        <Probe />
      </WalletProvider>
    </RuntimeProvider>
  );
}
