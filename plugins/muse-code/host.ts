// bb-plugin-muse-code host entry.
//
// Ships bb's canonical ACP provider bridge (the same one the builtin
// provider-acp plugin uses). The runtime spawns this artifact as the provider
// bridge; per-agent launch facts arrive in
// `options.providerOptions.acpLaunchSpec` from server.ts.
//
// The same artifact answers the plugin's host RPC, so `bb muse-code install`
// and `status` run on the machine the daemon executes on rather than on the
// bb server.
import { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { museHostContract } from "./contract.js";
import { runInstall } from "./install.js";
import { probeLocal } from "./probe.js";

export { experimental_providerBridge };

export default experimental_defineHostEntry({
  contract: museHostContract,
  handlers: {
    probe: async () => probeLocal(),
    install: async (input) =>
      runInstall({
        installDir: input.installDir,
        ...(input.version === undefined ? {} : { version: input.version }),
        force: input.force,
      }),
  },
});
