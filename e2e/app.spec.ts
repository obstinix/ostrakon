import { expect, test, type Page } from "@playwright/test";


// Seeded world (scripts/lib/seed.ts):
//  #1 Student Council 2026  Voting      admin #0, voters #2..#6, #2 #3 #4 voted
//  #2 Library Hours         Registration admin #1, voters #2 #3
//  #3 Robotics Club Lead    Ended+final  winner index 1 (Meera Pillai)
//  #4 Cultural Fest Theme   Ended+final  tie
//  #5 Hostel Mess Committee Registration, scheduled to open in 10 min
//  #6 Sports Captain       secret ballot, Voting; #2 #3 sealed, #4 #5 registered
const ACC = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
];

/** Raw-error leakage check: none of these may ever appear in rendered text. */
const RAW = [/execution reverted/i, /ContractFunction/i, /Error:/, /at .+\.(ts|js):\d+/, /0x[0-9a-f]{24,}/i, /Details:/, /Version: viem/i];

async function assertNoRawErrors(page: Page) {
  const text = await page.locator("body").innerText();
  for (const r of RAW) expect(text, `raw error pattern ${r}`).not.toMatch(r);
}

async function asMock(page: Page, account: number, extra: Record<string, unknown> = {}) {
  await page.addInitScript((o) => {
    window.__OSTRAKON_E2E__ = o;
  }, { account, ...extra });
}

async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("role")).not.toHaveText("Read-only");
}

/** Stub EIP-1193 provider: exercises the real `injected` connector path. */
async function stubWallet(page: Page, opts: { locked?: boolean; chainId?: string; account: string; rpc: string }) {
  await page.addInitScript((o) => {
    window.__OSTRAKON_E2E__ = { mock: false };
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    let chainId = o.chainId ?? "0x7a69";
    let connected = false;
    const calls: string[] = [];
    (window as unknown as { __stubCalls: string[] }).__stubCalls = calls;
    const emit = (e: string, v: unknown) => (listeners[e] ?? []).forEach((f) => f(v));
    // Lets a test act like the user switching networks inside the wallet.
    (window as unknown as { __stubSetChain: (c: string) => void }).__stubSetChain = (c: string) => {
      chainId = c;
      emit("chainChanged", c);
    };
    (window as unknown as { ethereum: unknown }).ethereum = {
      isMetaMask: true,
      _metamask: { isUnlocked: async () => !o.locked },
      on: (e: string, f: (...a: unknown[]) => void) => {
        (listeners[e] ??= []).push(f);
      },
      removeListener: (e: string, f: (...a: unknown[]) => void) => {
        listeners[e] = (listeners[e] ?? []).filter((x) => x !== f);
      },
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        calls.push(method);
        switch (method) {
          case "eth_chainId":
            return chainId;
          case "eth_accounts":
            return connected && !o.locked ? [o.account] : [];
          case "eth_requestAccounts":
            if (o.locked) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            connected = true;
            return [o.account];
          case "wallet_requestPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "wallet_getPermissions":
            return connected ? [{ parentCapability: "eth_accounts" }] : [];
          case "wallet_switchEthereumChain":
            chainId = (params?.[0] as { chainId: string }).chainId;
            emit("chainChanged", chainId);
            return null;
          case "wallet_addEthereumChain":
            return null;
          default: {
            const res = await fetch(o.rpc, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
            });
            const j = await res.json();
            if (j.error) throw j.error;
            return j.result;
          }
        }
      },
    };
  }, opts);
}

const RPC = process.env.OSTRAKON_RPC ?? "http://127.0.0.1:8546";

test.describe.configure({ mode: "serial" });

test("read-only without a wallet: ledger, network bar, explanation", async ({ page }) => {
  await page.addInitScript(() => {
    window.__OSTRAKON_E2E__ = { mock: false };
  });
  await page.goto("/");
  await expect(page.getByTestId("notice-no-wallet")).toBeVisible();
  await expect(page.getByTestId("block-number")).toHaveText(/#\d+/);
  await expect(page.getByTestId("role")).toHaveText("Read-only");
  await expect(page.locator(".ledger-item")).toHaveCount(6);
  await expect(page.locator(".ledger")).toContainText("Student Council 2026");
  await page.goto("/e/3");
  await expect(page.getByTestId("result")).toContainText("Meera Pillai");
  await page.goto("/e/4");
  await expect(page.getByTestId("result")).toContainText("Tie");
  await assertNoRawErrors(page);
});

test("locked wallet is detected and explained", async ({ page }) => {
  await stubWallet(page, { locked: true, account: ACC[2]!, rpc: RPC });
  await page.goto("/");
  await expect(page.getByTestId("notice-locked")).toBeVisible();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("notice-wallet-error")).toContainText("You cancelled the request in your wallet.");
  await assertNoRawErrors(page);
});

test("wrong chain: switched on connect, detected when the wallet changes network, one-click fix", async ({ page }) => {
  await stubWallet(page, { chainId: "0x1", account: ACC[2]!, rpc: RPC });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  // Connecting from chain 1 asks the wallet to switch to the app's chain.
  await expect(page.getByTestId("role")).toContainText("Voter");
  let calls = await page.evaluate(() => (window as unknown as { __stubCalls: string[] }).__stubCalls);
  expect(calls).toContain("wallet_switchEthereumChain");

  // The user then switches the wallet to another network.
  await page.evaluate(() => (window as unknown as { __stubSetChain: (c: string) => void }).__stubSetChain("0x1"));
  await expect(page.getByTestId("notice-wrong-chain")).toBeVisible();
  await expect(page.getByTestId("notice-wrong-chain")).toContainText("chain 1");
  await expect(page.getByTestId("role")).toHaveText("Read-only");
  await page.getByRole("button", { name: "Switch network" }).click();
  await expect(page.getByTestId("notice-wrong-chain")).toHaveCount(0);
  await expect(page.getByTestId("role")).toContainText("Voter");
  calls = await page.evaluate(() => (window as unknown as { __stubCalls: string[] }).__stubCalls);
  expect(calls.filter((c) => c === "wallet_switchEthereumChain").length).toBeGreaterThanOrEqual(2);
});

test("a rejected connection shows curated copy only", async ({ page }) => {
  await asMock(page, 2, { connectError: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("notice-wallet-error")).toContainText("You cancelled the request in your wallet.");
  await assertNoRawErrors(page);
});

test("registered voter votes with the keyboard; tally and eligibility update", async ({ page }) => {
  await asMock(page, 6); // registered in #1, has not voted
  await page.goto("/e/1");
  await connect(page);
  await expect(page.getByTestId("eligibility")).toContainText("You can vote");
  const before = Number((await page.getByTestId("candidate-2").locator(".card-tally .count > .sr-only").textContent()) ?? "0");

  // Keyboard only: focus the card face, open it, then activate the buttons.
  const face = page.getByTestId("candidate-2").locator(".card-face");
  await face.focus();
  await page.keyboard.press("Enter");
  await expect(face).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Vote for Sneha Jadhav" }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Confirm vote" }).focus();
  await page.keyboard.press("Enter");

  const status = page.getByTestId("tx-status").first();
  await expect(status).toContainText(/Confirmed in block \d+/, { timeout: 20_000 });
  await expect(page.getByTestId("eligibility")).toContainText("You voted");
  await expect(page.getByTestId("candidate-2").locator(".card-tally .count > .sr-only")).toHaveText(String(before + 1));
  // The vote button is gone: double votes are not offered.
  await expect(page.getByRole("button", { name: /^Vote for/ })).toHaveCount(0);
  await assertNoRawErrors(page);
});

test("unregistered account sees why it can't vote", async ({ page }) => {
  await asMock(page, 7);
  await page.goto("/e/1");
  await connect(page);
  await expect(page.getByTestId("eligibility")).toContainText("Not on the voter list");
  await page.getByTestId("candidate-0").locator(".card-face").click();
  await expect(page.getByRole("button", { name: /^Vote for/ })).toHaveCount(0);
});

test("admin: validate a pasted list, register, run the election to a result", async ({ page }) => {
  await asMock(page, 1); // admin of #2
  await page.goto("/e/2");
  await connect(page);
  await page.getByRole("link", { name: "Manage election" }).click();

  const bad = ACC[6]!.slice(0, 41) + (ACC[6]!.endsWith("9") ? "a" : "9"); // wrong last char -> not this account
  const flipped = ACC[5]!.replace("9965507D1a55", "9965507d1A55"); // case flip -> bad checksum
  const list = [ACC[2], ACC[6], ACC[6]!.toLowerCase(), "0x" + "0".repeat(40), "not-an-address", flipped, ACC[7]].join("\n");
  await page.getByLabel(/Paste addresses/).fill(list);
  const preview = page.getByTestId("voter-preview");
  await expect(preview).toContainText("Will register2"); // #6, #7
  await expect(preview).toContainText("Already registered1"); // #2
  await expect(preview).toContainText("Repeated in list1");
  await expect(preview).toContainText("bad checksum");
  void bad;

  await page.getByRole("button", { name: "Register 2 voters" }).click();
  await expect(page.getByTestId("tx-status").nth(1)).toContainText(/Confirmed/, { timeout: 20_000 });

  await page.getByRole("button", { name: "Open voting" }).click();
  await expect(page.locator(".phase-steps .now")).toHaveText("Voting", { timeout: 20_000 });
  await page.getByRole("button", { name: "Close voting" }).click();
  await expect(page.locator(".phase-steps .now")).toHaveText("Ended", { timeout: 20_000 });
  await page.getByRole("button", { name: "Finalize result" }).click();
  await expect(page.getByText("The result is final.")).toBeVisible({ timeout: 20_000 });
  await page.goto("/e/2");
  await expect(page.getByTestId("result")).toContainText("No votes were counted");
  await assertNoRawErrors(page);
});

test("non-admin cannot see admin controls", async ({ page }) => {
  await asMock(page, 2);
  await page.goto("/e/1");
  await connect(page);
  await expect(page.getByRole("link", { name: "Manage election" })).toHaveCount(0);
  await page.goto("/e/1/manage");
  await expect(page.getByRole("heading", { name: "Admin only" })).toBeVisible();
});

test("audit: verify-my-vote shows only what the chain proves", async ({ page }) => {
  await asMock(page, 2); // voted in #1, #3, #4; sealed in #6
  await page.goto("/audit");
  await connect(page);
  const verify = page.getByTestId("verify");
  await expect(verify.locator(".receipt")).toHaveCount(4);
  await expect(verify.locator(".receipt").last()).toContainText("Sealed: choice hidden");
  await expect(verify.locator(".receipt").last()).toContainText("hidden on chain");
  await expect(verify).toContainText("shows the candidate publicly");
  await expect(page.locator("table.table tbody tr").first()).toBeVisible();
  await expect(page.locator("table.table")).toContainText("Voted");
  await assertNoRawErrors(page);
});

test("secret ballot: seal, keep the receipt, reveal in this browser or with a pasted receipt", async ({
  page,
  browser,
}) => {
  // Voter #4 seals a vote for Omkar Joshi (index 1). Tallies are hidden while voting is open.
  await asMock(page, 4);
  await page.goto("/e/6");
  await connect(page);
  await expect(page.getByTestId("eligibility")).toContainText("You can vote");
  await expect(page.getByTestId("candidate-1").locator(".sealed")).toBeVisible();
  await expect(page.getByTestId("count-line")).toContainText("2 sealed votes");
  await page.getByTestId("candidate-1").locator(".card-face").click();
  await page.getByRole("button", { name: "Seal vote for Omkar Joshi" }).click();
  await expect(page.getByTestId("candidate-1").getByText("hidden until you reveal it")).toBeVisible();
  await page.getByRole("button", { name: "Confirm sealed vote" }).click();
  await expect(page.getByTestId("tx-status").first()).toContainText(/Confirmed in block \d+/, { timeout: 20_000 });
  await expect(page.getByTestId("eligibility")).toContainText("Your vote is sealed");
  await expect(page.getByRole("button", { name: "Download a copy" })).toBeVisible();
  await expect(page.getByTestId("count-line")).toContainText("3 sealed votes");
  // The on-chain record shows a sealed vote with no choice.
  await expect(page.locator(".block-VoteCommitted").last()).toContainText("choice hidden");

  // Voter #5 seals on "another device" (separate browser context), voting for Neha Bhosale (index 2).
  const other = await browser.newContext();
  const p5 = await other.newPage();
  await asMock(p5, 5);
  await p5.goto("/e/6");
  await connect(p5);
  await p5.getByTestId("candidate-2").locator(".card-face").click();
  await p5.getByRole("button", { name: "Seal vote for Neha Bhosale" }).click();
  await p5.getByRole("button", { name: "Confirm sealed vote" }).click();
  await expect(p5.getByTestId("eligibility")).toContainText("Your vote is sealed", { timeout: 20_000 });
  const receipt5 = await p5.evaluate(
    () => Object.entries(localStorage).find(([k]) => k.startsWith("ostrakon:receipt:"))?.[1] ?? "",
  );
  const receipt4 = await page.evaluate(
    () => Object.entries(localStorage).find(([k]) => k.startsWith("ostrakon:receipt:"))?.[1] ?? "",
  );
  expect(JSON.parse(receipt5).candidateIndex).toBe(2);
  await other.close();

  // Admin #0 closes voting and opens Reveal (another session).
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await asMock(adminPage, 0);
  await adminPage.goto("/e/6/manage");
  await connect(adminPage);
  await adminPage.getByRole("button", { name: "Close voting, open reveal" }).click();
  await expect(adminPage.locator(".phase-steps .now")).toHaveText("Reveal", { timeout: 20_000 });
  await adminCtx.close();

  // #4 reveals with the receipt this browser kept.
  await page.reload();
  await connect(page);
  await expect(page.getByTestId("count-line")).toContainText("0 of 4 sealed votes revealed");
  await page.getByRole("button", { name: "Reveal my vote for Omkar Joshi" }).click();
  await expect(page.getByTestId("eligibility")).toContainText("Your vote is counted", { timeout: 20_000 });
  await expect(page.getByTestId("candidate-1").locator(".count > .sr-only")).toHaveText("1");
  await assertNoRawErrors(page);

  // #5, on a fresh device with no stored receipt, first pastes the wrong receipt, then the right one.
  const fresh = await browser.newContext();
  const p5b = await fresh.newPage();
  await asMock(p5b, 5);
  await p5b.goto("/e/6");
  await connect(p5b);
  await expect(p5b.getByTestId("eligibility")).toContainText("No matching receipt in this browser");
  const paste = p5b.getByTestId("eligibility").locator("textarea");
  await paste.fill(receipt4);
  await p5b.getByRole("button", { name: "Reveal with this receipt" }).click();
  await expect(p5b.getByTestId("eligibility")).toContainText("different account, election or sealed vote");
  await paste.fill(receipt5);
  await p5b.getByRole("button", { name: "Reveal with this receipt" }).click();
  await expect(p5b.getByTestId("eligibility")).toContainText("Your vote is counted", { timeout: 20_000 });
  await expect(p5b.getByTestId("candidate-2").locator(".count > .sr-only")).toHaveText("1");
  await expect(p5b.getByTestId("count-line")).toContainText("2 of 4 sealed votes revealed");
  await assertNoRawErrors(p5b);
  await fresh.close();
});

test("anyone can create an election and lands on it", async ({ page }) => {
  await asMock(page, 7);
  await page.goto("/new");
  await connect(page);
  await page.getByLabel("Election name").fill("E2E Committee");
  await page.getByLabel(/Candidates, one per line/).fill("Alpha\nAlpha");
  await page.getByRole("button", { name: "Create election" }).click();
  await expect(page.getByRole("alert")).toContainText("Candidates 1 and 2 have the same name.");
  await page.getByLabel(/Candidates, one per line/).fill("Alpha\nBeta");
  await page.getByRole("button", { name: "Create election" }).click();
  await expect(page).toHaveURL(/\/e\/7$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E Committee");
  await expect(page.getByRole("link", { name: "Manage election" })).toBeVisible();

  // Secret ballot: a scheduled reveal close without a voting close is caught before sending.
  await page.goto("/new");
  await connect(page);
  await page.getByLabel("Election name").fill("E2E Secret");
  await page.getByLabel(/Candidates, one per line/).fill("Alpha\nBeta");
  await page.getByLabel(/Secret ballot \(commit–reveal\)/).check();
  await page.getByLabel("Reveal closes").fill("2099-01-01T10:00");
  await page.getByRole("button", { name: "Create election" }).click();
  await expect(page.getByRole("alert")).toContainText("needs a scheduled voting close too");
  await page.getByLabel("Reveal closes").fill("");
  await page.getByRole("button", { name: "Create election" }).click();
  await expect(page).toHaveURL(/\/e\/8$/, { timeout: 20_000 });
  await expect(page.locator(".el-meta")).toContainText("Secret ballot");
  await expect(page.locator(".phase-notches i")).toHaveCount(4);
});

test("360px: no horizontal scroll, ledger rows stack", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.addInitScript(() => {
    window.__OSTRAKON_E2E__ = { mock: false };
  });
  for (const path of ["/", "/e/1", "/audit", "/how", "/new"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
  await page.goto("/");
  await expect(page.locator(".ledger-cols")).toBeHidden();
});

test("reduced motion: final values render immediately, no transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.__OSTRAKON_E2E__ = { mock: false };
  });
  await page.goto("/e/3");
  await expect(page.locator(".card")).toHaveCount(4);
  // Visible digits equal the real tally without waiting for any animation.
  const visible = await page.locator(".card-tally .count > [aria-hidden=true]").allTextContents();
  const real = await page.locator(".card-tally .count > .sr-only").allTextContents();
  expect(visible).toEqual(real);
  const duration = await page.locator(".bar-fill").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(duration).toBe("0s");
});

test("stale deployment (no code at the saved address) is explained, not blank", async ({ page }) => {
  await page.addInitScript(() => {
    window.__OSTRAKON_E2E__ = { mock: false };
  });
  await page.route("**/deployment.json", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, address: ACC[7] } }); // an EOA: no contract code
  });
  await page.goto("/");
  await expect(page.getByTestId("notice-stale")).toContainText("isn't at the saved address");
  await expect(page.getByTestId("notice-stale")).toContainText("npm run chain:deploy");
  await expect(page.getByRole("status").filter({ hasText: "no contract at the saved address" })).toBeVisible();
  await assertNoRawErrors(page);
});

test("unreachable chain is explained, not blank", async ({ page }) => {
  await page.addInitScript(() => {
    window.__OSTRAKON_E2E__ = { mock: false };
  });
  await page.route("**/deployment.json", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, rpcUrl: "http://127.0.0.1:1", wsUrl: undefined } });
  });
  await page.goto("/");
  await expect(page.getByTestId("notice-rpc-down")).toContainText("Can't reach the chain", { timeout: 8_000 });
  await expect(page.getByRole("status").filter({ hasText: "chain is unreachable" })).toBeVisible();
  await assertNoRawErrors(page);
});

test("missing deployment.json explains how to get one", async ({ page }) => {
  await page.route("**/deployment.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No contract to read yet" })).toBeVisible();
  await expect(page.locator(".cmd")).toHaveText("npm run dev");
});
