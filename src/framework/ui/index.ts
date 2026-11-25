/**
 * Field UI for the Mimamori Framework. Browser-only (uses the DOM); kept out of
 * src/framework/index.ts so server code does not depend on it.
 */
export * from "./client.ts";
export * from "./labels.ts";
export { HttpFrameworkClient, type HttpFrameworkClientOptions } from "./http-client.ts";
export { mountFrameworkApp, type MountOptions } from "./app.ts";
export { FRAMEWORK_UI_CSS } from "./styles.ts";
