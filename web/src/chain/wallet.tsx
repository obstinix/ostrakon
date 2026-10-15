import { createContext, useContext, type ReactNode } from "react";
import { useWalletController } from "./hooks";

type Wallet = ReturnType<typeof useWalletController>;
const WalletContext = createContext<Wallet | null>(null);

/** One wallet controller for the whole app (one provider probe, one error slot). */
export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useWalletController();
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
}

export function useWallet(): Wallet {
  const w = useContext(WalletContext);
  if (!w) throw new Error("useWallet outside WalletProvider");
  return w;
}
