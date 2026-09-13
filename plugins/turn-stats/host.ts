// bb-plugin-turn-stats host entry.
//
// Ships bb's canonical ACP provider bridge — the same one provider-acp and
// bb-plugin-muse-code use — so the "Devin (stats tap)" provider registered in
// server.ts can run sessions. The bridge launches the tap shim (see
// acpLaunchSpec in server.ts), which proxies to `devin acp` unchanged.
export { experimental_acpProviderBridge as experimental_providerBridge }
  from "@get-bb/plugin-sdk/provider-bridge/acp";
