import { FRAMEWORK_SECTORS, type FrameworkSector } from "../types.ts";
import { mountFrameworkApp } from "./app.ts";
import { LocalDemoClient } from "./local-client.ts";

/**
 * Entry point of the public static demo (Hugging Face Space). Runs the real
 * Framework + Care Ops engine in the browser with synthetic data only; the page's
 * CSP (connect-src 'none') prevents any network access.
 */
const root = document.getElementById("app");
if (root) {
  const client = new LocalDemoClient();
  const requested = new URLSearchParams(location.search).get("sector");
  const sector = (FRAMEWORK_SECTORS as readonly string[]).includes(requested ?? "") ? (requested as FrameworkSector) : "care";
  await client.setSector(sector);
  mountFrameworkApp(root, { client, demo: client });
}
