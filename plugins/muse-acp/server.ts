// bb-plugin-muse-acp — Muse Code as a first-class bb agent provider, through
// the muse-acp adapter (https://github.com/BrokkAi/muse-acp).
//
// Scaffold only. The provider registration lands here once two decisions are
// settled; both are recorded in README.md:
//   - the provider id, which is permanent once published
//   - the provider icon, which is the reason this plugin exists at all
//
// Capabilities the adapter actually advertises (read from muse-acp v0.2.5
// src/main.rs V1_INIT/V2_INIT and src/acp.rs config_options):
//   authMethods:  []            — Muse Code signs in out of band, via `muse`
//   loadSession:  true          — sessionCapabilities list/resume/close, no fork
//   prompt:       text, image, embeddedContext (no audio)
//   session mode: ask | auto | deny
//   reasoning:    none | minimal | low | medium | high | xhigh | ultra
import { type BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(_bb: BbPluginApi) {}
