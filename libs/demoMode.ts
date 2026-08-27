export const DEMO_MODE: boolean = (() => {
  const raw = (process.env.BRIDGE_DEMO_MODE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
})();
