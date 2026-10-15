// Test hook read by web/src/chain/testConnector.ts (E2E builds only).
interface Window {
  __OSTRAKON_E2E__?: { account?: number; connectError?: boolean; mock?: boolean; signError?: boolean };
}
